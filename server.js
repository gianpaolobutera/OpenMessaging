require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const axios = require('axios');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const MAX_PDF_SIZE_BYTES = 25 * 1024 * 1024;

app.use(express.json());
app.use(express.static('public')); // Serves your HTML/JS files

// Set via environment for security (do not commit secrets)
const GENESYS_REGION = process.env.GENESYS_REGION || 'euc2';
const GENESYS_API_URL = process.env.GENESYS_API_URL || `https://api.${GENESYS_REGION}.pure.cloud`;
const GENESYS_CLIENT_ID = process.env.GENESYS_CLIENT_ID || '<YOUR_CLIENT_ID>'; // set in .env
const GENESYS_CLIENT_SECRET = process.env.GENESYS_CLIENT_SECRET || '<YOUR_CLIENT_SECRET>'; // set in .env
const INTEGRATION_ID = process.env.INTEGRATION_ID || '<YOUR_INTEGRATION_ID>'; // set in .env

function normalizeString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function sanitizeFilename(filename, fallback = 'document.pdf') {
    const trimmed = normalizeString(filename);
    if (!trimmed) return fallback;
    return trimmed.toLowerCase().endsWith('.pdf') ? trimmed : `${trimmed}.pdf`;
}

function normalizePdfAttachment(input, index = 0) {
    const source = input && typeof input === 'object' ? input : {};
    const attachment = source.attachment && typeof source.attachment === 'object' ? source.attachment : source;
    const url = normalizeString(attachment.url || attachment.attachmentUrl || source.attachmentUrl);
    const mime = normalizeString(attachment.mime || attachment.contentType || source.mime || source.contentType || 'application/pdf').toLowerCase();
    const filename = sanitizeFilename(attachment.filename || attachment.attachmentFilename || source.filename || source.attachmentFilename || `document-${index + 1}.pdf`);
    const contentSizeBytes = Number(attachment.contentSizeBytes || attachment.sizeBytes || source.contentSizeBytes || source.sizeBytes || 0);
    const text = normalizeString(attachment.text || attachment.caption || source.text || source.caption);
    const sha256 = normalizeString(attachment.sha256 || source.sha256);

    if (!url) {
        throw new Error(`Attachment ${index + 1} is missing a public HTTPS url`);
    }
    if (!/^https:\/\//i.test(url)) {
        throw new Error(`Attachment ${index + 1} url must use HTTPS`);
    }
    if (mime !== 'application/pdf') {
        throw new Error(`Attachment ${index + 1} must use application/pdf mime type`);
    }
    if (Number.isFinite(contentSizeBytes) && contentSizeBytes > MAX_PDF_SIZE_BYTES) {
        throw new Error(`Attachment ${index + 1} exceeds the 25 MB PDF limit`);
    }

    return {
        contentType: 'Attachment',
        attachment: {
            mediaType: 'File',
            url,
            mime: 'application/pdf',
            filename,
            ...(Number.isFinite(contentSizeBytes) && contentSizeBytes > 0 ? { contentSizeBytes } : {}),
            ...(sha256 ? { sha256 } : {}),
            ...(text ? { text } : {})
        }
    };
}

function extractInboundPdfAttachments(body) {
    const attachments = [];

    if (Array.isArray(body?.attachments)) attachments.push(...body.attachments);
    if (body?.attachment) attachments.push(body.attachment);
    if (body?.attachmentUrl || body?.attachmentFilename) {
        attachments.push({
            url: body.attachmentUrl,
            filename: body.attachmentFilename,
            contentSizeBytes: body.contentSizeBytes,
            sha256: body.sha256,
            text: body.attachmentText
        });
    }
    if (Array.isArray(body?.content)) {
        attachments.push(...body.content);
    }

    return attachments.map((entry, index) => normalizePdfAttachment(entry, index));
}

function collectOutboundPdfAttachments(payload) {
    const buckets = [
        payload?.content,
        payload?.event?.content,
        payload?.body?.content,
        payload?.message?.content,
        payload?.event?.message?.content,
        payload?.body?.message?.content,
        payload?.body?.event?.content,
        payload?.body?.event?.message?.content
    ];

    const attachments = [];
    for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue;
        for (const item of bucket) {
            try {
                const normalized = normalizePdfAttachment(item, attachments.length);
                attachments.push({
                    url: normalized.attachment.url,
                    filename: normalized.attachment.filename,
                    mime: normalized.attachment.mime,
                    contentSizeBytes: normalized.attachment.contentSizeBytes,
                    sha256: normalized.attachment.sha256,
                    text: normalized.attachment.text
                });
            } catch {
            }
        }
    }

    return attachments;
}

function assertLocalConfig() {
    const missing = [];
    if (!process.env.GENESYS_CLIENT_ID) missing.push('GENESYS_CLIENT_ID');
    if (!process.env.GENESYS_CLIENT_SECRET) missing.push('GENESYS_CLIENT_SECRET');
    if (!process.env.INTEGRATION_ID) missing.push('INTEGRATION_ID');

    if (missing.length > 0) {
        throw new Error(`Missing local .env values: ${missing.join(', ')}`);
    }
}

// Get a client credential token from Genesys Cloud (non-user context)
async function getAccessToken() {
    // Genesys login endpoint is in the same region; for api URL like https://api.euc2.pure.cloud -> login url is https://login.euc2.pure.cloud
    const loginBase = process.env.GENESYS_AUTH_URL || GENESYS_API_URL.replace('api.', 'login.');
    const tokenUrl = `${loginBase.replace(/\/+$/, '')}/oauth/token`;

    try {
        const result = await axios.post(tokenUrl, new URLSearchParams({
            grant_type: 'client_credentials',
            scope: 'conversation:messages:create integration:openMessaging'
        }), {
            auth: {
                username: GENESYS_CLIENT_ID,
                password: GENESYS_CLIENT_SECRET
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        return result.data.access_token;
    } catch (e) {
        console.error('Token acquisition failed', e.response ? e.response.data : e.message);
        throw new Error('Failed to get Genesys client credentials token');
    }
}

// 1. INBOUND: Web Page -> Middleware -> Genesys
app.post('/send-to-genesys', async (req, res) => {
    const { text, visitorId, visitorNickname, participantAttributes } = req.body;
    try {
        const attachments = extractInboundPdfAttachments(req.body || {});
        const normalizedText = normalizeString(text);
        if (!visitorId || (!normalizedText && attachments.length === 0)) {
            return res.status(400).send('Missing required fields: visitorId and text or PDF attachment');
        }

        const token = await getAccessToken();
        const now = new Date().toISOString();
        const messageId = `${visitorId}-${crypto.randomUUID()}`;

        const customAttributes = {
            visitorId,
            ...(participantAttributes && typeof participantAttributes === 'object' ? participantAttributes : {}),
            channel: 'open-messaging-webchat'
        };

        const payload = {
            channel: {
                messageId,
                from: {
                    id: visitorId,
                    idType: 'Opaque',
                    nickname: visitorNickname || 'Web Customer'
                },
                time: now,
                metadata: {
                    customAttributes
                }
            },
            direction: 'Inbound',
            text: normalizedText || (attachments.length === 1 ? 'PDF document attached' : 'PDF documents attached'),
            ...(attachments.length > 0 ? { content: attachments } : {})
        };

        const payloadVariants = [
            {
                label: 'channel.metadata.customAttributes',
                payload
            },
            {
                label: 'channel.customAttributes',
                payload: {
                    ...payload,
                    channel: {
                        ...payload.channel,
                        metadata: undefined,
                        customAttributes
                    }
                }
            },
            {
                label: 'base',
                payload: {
                    ...payload,
                    channel: {
                        ...payload.channel,
                        metadata: undefined
                    }
                }
            }
        ];

        const endpoint = `${GENESYS_API_URL}/api/v2/conversations/messages/${INTEGRATION_ID}/inbound/open/message`;
        let lastError = null;

        for (const variant of payloadVariants) {
            try {
                console.log(`send-to-genesys payload (${variant.label}):`, JSON.stringify(variant.payload, null, 2));
                const response = await axios.post(endpoint, variant.payload, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                });

                if (response.status === 200 || response.status === 201) {
                    console.log('send-to-genesys accepted using variant:', variant.label);
                    return res.sendStatus(200);
                }
            } catch (variantErr) {
                lastError = variantErr;
            }
        }

        console.warn('Genesys inbound response failed for all payload variants');
        const status = lastError?.response?.status || 500;
        const message = lastError?.response?.data || lastError?.message || 'Unknown send-to-genesys error';
        return res.status(status).send(message);
    } catch (err) {
        console.error('send-to-genesys error', err.response ? err.response.data : err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data || err.message;
        res.status(status).send(message);
    }
});

// 1b. INBOUND DISCONNECT: Web Page -> Middleware -> Genesys (empty event + participant data)
app.post('/disconnect-customer', async (req, res) => {
    const { visitorId, visitorNickname } = req.body;
    if (!visitorId) {
        return res.status(400).send('Missing required field: visitorId');
    }

    try {
        const token = await getAccessToken();
        const now = new Date().toISOString();
        const messageId = `${visitorId}-disconnect-${crypto.randomUUID()}`;

        const customAttributes = {
            visitorId,
            status: 'disconnect-customer'
        };

        const basePayload = {
            channel: {
                messageId,
                from: {
                    id: visitorId,
                    idType: 'Opaque',
                    nickname: visitorNickname || 'Web Customer'
                },
                time: now,
                metadata: {
                    customAttributes
                }
            },
            direction: 'Inbound',
            text: 'disconnect-customer'
        };

        const payloadVariants = [
            {
                label: 'channel.metadata.customAttributes',
                payload: basePayload
            },
            {
                label: 'channel.customAttributes',
                payload: {
                    ...basePayload,
                    channel: {
                        ...basePayload.channel,
                        customAttributes
                    }
                }
            }
        ];

        const endpoint = `${GENESYS_API_URL}/api/v2/conversations/messages/${INTEGRATION_ID}/inbound/open/message`;
        const attempts = [];
        let finalError = null;

        for (const variant of payloadVariants) {
            try {
                console.log(`disconnect-customer payload (${variant.label}):`, JSON.stringify(variant.payload, null, 2));
                const response = await axios.post(endpoint, variant.payload, {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                });

                attempts.push({ label: variant.label, status: response.status, ok: true });
                if (response.status === 200 || response.status === 201 || response.status === 202) {
                    console.log('disconnect-customer accepted using variant:', variant.label);
                    return res.sendStatus(200);
                }
            } catch (variantErr) {
                finalError = variantErr;
                attempts.push({
                    label: variant.label,
                    status: variantErr.response?.status || 500,
                    ok: false,
                    body: variantErr.response?.data || variantErr.message
                });
            }
        }

        console.warn('Genesys disconnect attempts failed', JSON.stringify(attempts));
        if (finalError) {
            const status = finalError.response?.status || 500;
            const message = finalError.response?.data || finalError.message;
            return res.status(status).send(message);
        }

        return res.status(502).send('Disconnect event not accepted by Genesys');
    } catch (err) {
        console.error('disconnect-customer error', err.response ? err.response.data : err.message);
        const status = err.response?.status || 500;
        const message = err.response?.data || err.message;
        return res.status(status).send(message);
    }
});

// 2. OUTBOUND: Genesys Webhook -> Middleware -> Web Page (via Socket.io)
app.post('/genesys-webhook', (req, res) => {
    const outboundMessage = req.body;
    console.log('genesys-webhook received event:', JSON.stringify(outboundMessage));

    // Open Messaging callback may nest message payloads and direction fields
    const direction = outboundMessage.direction || outboundMessage.event?.direction || outboundMessage.body?.direction;
    const text = outboundMessage.text || outboundMessage.event?.text || outboundMessage.body?.text;
    const attachments = collectOutboundPdfAttachments(outboundMessage);
    const agentName = outboundMessage.channel?.from?.nickname || outboundMessage.channel?.from?.name || 'Agent';

    if (direction === 'Outbound' && (text || attachments.length > 0)) {
        io.emit('agent-reply', {
            text: normalizeString(text),
            attachments,
            agentName
        });
    }

    res.sendStatus(200);
});

try {
    assertLocalConfig();
    server.listen(3000, () => console.log('Demo running on http://localhost:3000 (mode: local-node/.env)'));
} catch (err) {
    console.error('Startup configuration error:', err.message);
    process.exit(1);
}
