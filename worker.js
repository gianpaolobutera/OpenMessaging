// Secrets bound in Cloudflare dashboard: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, INTEGRATION_ID
// KV namespace bound as MESSAGES in Cloudflare dashboard

const GENESYS_API_URL = 'https://api.euc2.pure.cloud';

async function getAccessToken() {
    const tokenUrl = 'https://login.euc2.pure.cloud/oauth/token';
    const auth = btoa(`${GENESYS_CLIENT_ID}:${GENESYS_CLIENT_SECRET}`);
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' })
    });
    if (!response.ok) throw new Error(`Token failed: ${response.status}`);
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
                from: { id: visitorId, idType: 'Opaque' },
                time: now
            },
            direction: 'Inbound',
            text
        };

        const endpoint = `${GENESYS_API_URL}/api/v2/conversations/messages/${INTEGRATION_ID}/inbound/open/message`;
        const genesysResponse = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (genesysResponse.ok) return new Response('OK', { status: 200 });

        const errorData = await genesysResponse.text();
        return new Response(errorData, { status: genesysResponse.status });
    } catch (err) {
        return new Response(err.message, { status: 500 });
    }
}

async function handleGenesysWebhook(request) {
    try {
        const body = await request.json();
        console.log('webhook received:', JSON.stringify(body));

        const direction = body.direction || body.event?.direction || body.body?.direction;
        const text = body.text || body.event?.text || body.body?.text;
        const visitorId = body.channel?.from?.id || body.event?.channel?.from?.id || 'unknown';

        if (direction === 'Outbound' && text) {
            const existing = await MESSAGES.get(visitorId);
            const msgs = existing ? JSON.parse(existing) : [];
            msgs.push({ text, timestamp: new Date().toISOString() });
            await MESSAGES.put(visitorId, JSON.stringify(msgs), { expirationTtl: 3600 });
        }

        return new Response('OK', { status: 200 });
    } catch (err) {
        console.error('webhook error', err.message);
        return new Response(err.message, { status: 500 });
    }
}

async function handleGetMessages(request) {
    const url = new URL(request.url);
    const visitorId = url.searchParams.get('visitorId');
    const after = parseInt(url.searchParams.get('after') || '0');

    if (!visitorId) return new Response('Missing visitorId', { status: 400 });

    const existing = await MESSAGES.get(visitorId);
    const msgs = existing ? JSON.parse(existing) : [];
    const newMsgs = msgs.slice(after);

    return new Response(JSON.stringify({ messages: newMsgs, total: msgs.length }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Genesys Open Messaging Demo</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 40px auto; padding: 0 16px; }
        #chat { height: 360px; border: 1px solid #ccc; border-radius: 8px; overflow-y: scroll; padding: 12px; margin-bottom: 12px; background: #f9f9f9; }
        #chat p { margin: 6px 0; }
        .you { color: #1a73e8; }
        .agent { color: #2d7d32; }
        #controls { display: flex; gap: 8px; }
        #msg { flex: 1; padding: 8px; border: 1px solid #ccc; border-radius: 4px; }
        button { padding: 8px 16px; background: #1a73e8; color: white; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #1558b0; }
    </style>
</head>
<body>
    <h2>Genesys Open Messaging Demo</h2>
    <div id="chat"></div>
    <div id="controls">
        <input id="msg" type="text" placeholder="Type a message..." onkeydown="if(event.key==='\''Enter'\'') send()">
        <button onclick="send()">Send</button>
    </div>
    <script>
        const visitorId = '\''visitor-'\'' + Math.floor(Math.random() * 9000 + 1000);
        let seenCount = 0;

        async function send() {
            const input = document.getElementById('\''msg'\'');
            const text = input.value.trim();
            if (!text) return;
            appendMessage('\''You'\'', text, '\''you'\'');
            input.value = '\''\'';
            await fetch('\''/send-to-genesys'\'', {
                method: '\''POST'\'',
                headers: { '\''Content-Type'\'': '\''application/json'\'' },
                body: JSON.stringify({ text, visitorId })
            });
        }

        function appendMessage(sender, text, cls) {
            const chat = document.getElementById('\''chat'\'');
            chat.innerHTML += '\''<p class="'\'' + cls + '\''"><b>'\'' + sender + '\'':</b> '\'' + text + '\''</p>'\'';
            chat.scrollTop = chat.scrollHeight;
        }

        async function pollReplies() {
            try {
                const res = await fetch('\''/get-messages?visitorId='\'' + visitorId + '\''&after='\'' + seenCount);
                const data = await res.json();
                if (data.messages && data.messages.length > 0) {
                    data.messages.forEach(m => appendMessage('\''Agent'\'', m.text, '\''agent'\''));
                    seenCount = data.total;
                }
            } catch (e) { }
        }

        setInterval(pollReplies, 2000);
    </script>
</body>
</html>`;

async function handleRequest(request) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    if (method === 'POST' && pathname === '/send-to-genesys') return handleSendToGenesys(request);
    if (method === 'POST' && pathname === '/genesys-webhook') return handleGenesysWebhook(request);
    if (method === 'GET' && pathname === '/get-messages') return handleGetMessages(request);
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html' } });
    }

    return new Response('Not Found', { status: 404 });
}

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
});
