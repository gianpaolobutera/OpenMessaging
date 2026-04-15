require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const axios = require('axios');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public')); // Serves your HTML/JS files

// Set via environment for security (do not commit secrets)
const GENESYS_REGION = process.env.GENESYS_REGION || 'euc2';
const GENESYS_API_URL = process.env.GENESYS_API_URL || `https://api.${GENESYS_REGION}.pure.cloud`;
const GENESYS_CLIENT_ID = process.env.GENESYS_CLIENT_ID || '<YOUR_CLIENT_ID>'; // set in .env
const GENESYS_CLIENT_SECRET = process.env.GENESYS_CLIENT_SECRET || '<YOUR_CLIENT_SECRET>'; // set in .env
const INTEGRATION_ID = process.env.INTEGRATION_ID || '<YOUR_INTEGRATION_ID>'; // set in .env

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
        const token = await getAccessToken();
        const now = new Date().toISOString();
        const messageId = `${visitorId}-${crypto.randomUUID()}`;

        const customAttributes = {
            visitorId,
            ...(participantAttributes && typeof participantAttributes === 'object' ? participantAttributes : {}),
            channel: 'open-messaging-webchat'
        };

        const payload = {
            id: messageId,
            channel: {
                id: INTEGRATION_ID,
                platform: 'Open',
                type: 'Private',
                messageId,
                to: {
                    id: INTEGRATION_ID
                },
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
            type: 'Text',
            text: text,
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
            id: messageId,
            channel: {
                id: INTEGRATION_ID,
                platform: 'Open',
                type: 'Private',
                messageId,
                to: {
                    id: INTEGRATION_ID
                },
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
            type: 'Text',
            text: ''
        };

        const payloadVariants = [
            {
                label: 'channel.metadata.customAttributes:text-empty',
                payload: basePayload
            },
            {
                label: 'channel.metadata.customAttributes:text-space',
                payload: {
                    ...basePayload,
                    text: ' '
                }
            },
            {
                label: 'channel.customAttributes:text-empty',
                payload: {
                    ...basePayload,
                    channel: {
                        ...basePayload.channel,
                        customAttributes
                    }
                }
            },
            {
                label: 'channel.customAttributes:text-space',
                payload: {
                    ...basePayload,
                    text: ' ',
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

    if (direction === 'Outbound' && text) {
        io.emit('agent-reply', text);
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
