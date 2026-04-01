const GENESYS_REGION = 'euc2'; // Set in Cloudflare dashboard
const GENESYS_API_URL = `https://api.${GENESYS_REGION}.pure.cloud`;
// Secrets: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, INTEGRATION_ID set in Cloudflare dashboard

async function getAccessToken() {
    const loginBase = GENESYS_API_URL.replace('api.', 'login.');
    const tokenUrl = `${loginBase.replace(/\/+$/, '')}/oauth/token`;

    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'conversation:messages:create integration:openMessaging'
    });

    const auth = btoa(`${GENESYS_CLIENT_ID}:${GENESYS_CLIENT_SECRET}`);

    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
    });

    if (!response.ok) {
        throw new Error(`Token acquisition failed: ${response.status}`);
    }

    const data = await response.json();
    return data.access_token;
}

async function handleSendToGenesys(request) {
    try {
        const body = await request.json();
        const { text, visitorId } = body;

        const token = await getAccessToken();
        const now = new Date().toISOString();
        const messageId = `${visitorId}-${crypto.randomUUID()}`;

        const payload = {
            channel: {
                messageId,
                from: {
                    id: visitorId,
                    idType: 'Opaque',
                },
                time: now,
            },
            direction: 'Inbound',
            text: text,
        };

        console.log('send-to-genesys payload:', JSON.stringify(payload, null, 2));

        const endpoint = `${GENESYS_API_URL}/api/v2/conversations/messages/${INTEGRATION_ID}/inbound/open/message`;
        const genesysResponse = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload)
        });

        if (genesysResponse.ok) {
            return new Response('OK', { status: 200 });
        }

        const errorData = await genesysResponse.text();
        console.warn('Genesys inbound response', genesysResponse.status, errorData);
        return new Response(errorData, { status: genesysResponse.status });
    } catch (err) {
        console.error('send-to-genesys error', err.message);
        return new Response(err.message, { status: 500 });
    }
}

async function handleGenesysWebhook(request) {
    try {
        const body = await request.json();
        console.log('genesys-webhook received event:', JSON.stringify(body));
        // For demo, just log; in real app, emit to socket or something
        return new Response('OK', { status: 200 });
    } catch (err) {
        console.error('webhook error', err.message);
        return new Response(err.message, { status: 500 });
    }
}

async function handleRequest(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/send-to-genesys') {
        return await handleSendToGenesys(request);
    }

    if (request.method === 'POST' && url.pathname === '/genesys-webhook') {
        return await handleGenesysWebhook(request);
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
        // Serve index.html
        const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Genesys Open Messaging Demo</title>
</head>
<body>
    <h1>Genesys Open Messaging Demo</h1>
    <input type="text" id="message" placeholder="Type your message">
    <button onclick="sendMessage()">Send</button>
    <div id="replies"></div>

    <script src="https://cdn.socket.io/4.0.0/socket.io.min.js"></script>
    <script>
        const socket = io();

        socket.on('agent-reply', (text) => {
            document.getElementById('replies').innerHTML += '<p>' + text + '</p>';
        });

        async function sendMessage() {
            const text = document.getElementById('message').value;
            const visitorId = 'visitor-' + Math.floor(Math.random() * 1000);
            await fetch('/send-to-genesys', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text, visitorId })
            });
        }
    </script>
</body>
</html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }

    return new Response('Not Found', { status: 404 });
}

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});