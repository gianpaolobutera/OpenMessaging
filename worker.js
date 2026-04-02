// Cloud mode only: Worker uses Cloudflare bindings (not local .env file).
// Secrets in Cloudflare dashboard: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, INTEGRATION_ID
// KV binding in Cloudflare dashboard: MESSAGES

const UI_VERSION = '2026-04-02.1';

function getGenesysApiUrl(env) {
  return env.GENESYS_API_URL || 'https://api.euc2.pure.cloud';
}

function collectCandidateVisitorIds(payload) {
  const candidates = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) candidates.add(v.trim());
  };

  add(payload?.channel?.from?.id);
  add(payload?.channel?.to?.id);
  add(payload?.event?.channel?.from?.id);
  add(payload?.event?.channel?.to?.id);
  add(payload?.body?.channel?.from?.id);
  add(payload?.body?.channel?.to?.id);
  add(payload?.from?.id);
  add(payload?.to?.id);
  add(payload?.sender?.id);
  add(payload?.recipient?.id);
  add(payload?.metadata?.visitorId);
  add(payload?.event?.metadata?.visitorId);
  add(payload?.body?.metadata?.visitorId);

  return Array.from(candidates);
}

async function appendReply(env, visitorId, text) {
  const existing = await env.MESSAGES.get(visitorId);
  const msgs = existing ? JSON.parse(existing) : [];
  msgs.push({ text, timestamp: new Date().toISOString(), agentName: 'Agent' });
  await env.MESSAGES.put(visitorId, JSON.stringify(msgs), { expirationTtl: 3600 });
}

function extractAgentDisplayName(payload) {
  const candidates = [
    payload?.from?.name,
    payload?.sender?.name,
    payload?.agent?.name,
    payload?.user?.name,
    payload?.event?.from?.name,
    payload?.event?.sender?.name,
    payload?.event?.agent?.name,
    payload?.event?.user?.name,
    payload?.body?.from?.name,
    payload?.body?.sender?.name,
    payload?.body?.agent?.name,
    payload?.body?.user?.name,
    payload?.from?.displayName,
    payload?.sender?.displayName,
    payload?.agent?.displayName,
    payload?.event?.from?.displayName,
    payload?.event?.sender?.displayName,
    payload?.event?.agent?.displayName,
    payload?.body?.from?.displayName,
    payload?.body?.sender?.displayName,
    payload?.body?.agent?.displayName
  ];

  for (const name of candidates) {
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return 'Agent';
}

async function appendReplyWithName(env, visitorId, text, agentName) {
  const existing = await env.MESSAGES.get(visitorId);
  const msgs = existing ? JSON.parse(existing) : [];
  msgs.push({
    text,
    timestamp: new Date().toISOString(),
    agentName: agentName || 'Agent'
  });
  await env.MESSAGES.put(visitorId, JSON.stringify(msgs), { expirationTtl: 3600 });
}

async function setTypingState(env, visitorId, isTyping, source, ttlSeconds = 120) {
  const payload = {
    isTyping: Boolean(isTyping),
    source: source || 'unknown',
    at: new Date().toISOString()
  };
  await env.MESSAGES.put(`__typing:${visitorId}`, JSON.stringify(payload), { expirationTtl: ttlSeconds });
}

function matchesTypingEvent(payload) {
  const typeCandidates = [
    payload?.type,
    payload?.event?.type,
    payload?.body?.type,
    payload?.event?.messageType,
    payload?.body?.event?.messageType
  ];

  const eventTypeCandidates = [
    payload?.event?.eventType,
    payload?.eventType,
    payload?.body?.event?.eventType,
    payload?.body?.eventType,
    payload?.event?.type,
    payload?.body?.event?.type
  ];

  const hasEventTypeTyping = eventTypeCandidates.some(
    (v) => typeof v === 'string' && v.toLowerCase() === 'typing'
  );

  const hasEventContainer = typeCandidates.some(
    (v) => typeof v === 'string' && v.toLowerCase() === 'event'
  );

  return hasEventTypeTyping || (hasEventContainer && hasEventTypeTyping);
}

function normalizeSignatureHeader(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('sha256=') ? trimmed.slice(7) : trimmed;
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function validateWebhookSignature(rawBody, signatureHeader, secret) {
  const normalizedSignature = normalizeSignatureHeader(signatureHeader);
  if (!normalizedSignature || !secret) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expectedHex = bytesToHex(new Uint8Array(mac));
  return constantTimeEqual(expectedHex, normalizedSignature.toLowerCase());
}

async function getTypingState(env, visitorId) {
  const raw = await env.MESSAGES.get(`__typing:${visitorId}`);
  if (!raw) return { isTyping: false, source: null };
  try {
    return JSON.parse(raw);
  } catch {
    return { isTyping: false, source: null };
  }
}

function extractTypingState(payload) {
  const raw =
    payload?.typing?.state ||
    payload?.event?.typing?.state ||
    payload?.body?.typing?.state ||
    payload?.typingState ||
    payload?.event?.typingState ||
    payload?.body?.typingState ||
    payload?.eventType ||
    payload?.event?.eventType ||
    payload?.body?.eventType ||
    payload?.status ||
    payload?.event?.status ||
    payload?.body?.status ||
    null;

  if (!raw) return null;
  const normalized = String(raw).toLowerCase();
  if (
    ['on', 'start', 'started', 'true', 'typing'].includes(normalized) ||
    normalized.includes('typingstart') ||
    normalized.includes('typing_started') ||
    normalized.includes('typing.on')
  ) {
    return true;
  }
  if (
    ['off', 'stop', 'stopped', 'false', 'idle'].includes(normalized) ||
    normalized.includes('typingstop') ||
    normalized.includes('typing_stopped') ||
    normalized.includes('typing.off')
  ) {
    return false;
  }
  return null;
}

async function getAccessToken(env) {
  if (!env.GENESYS_CLIENT_ID || !env.GENESYS_CLIENT_SECRET) {
    throw new Error('Missing Worker secrets: GENESYS_CLIENT_ID or GENESYS_CLIENT_SECRET');
  }

    const loginUrl = getGenesysApiUrl(env).replace('api.', 'login.');
    const tokenUrl = `${loginUrl.replace(/\/+$/, '')}/oauth/token`;
  const auth = btoa(`${env.GENESYS_CLIENT_ID}:${env.GENESYS_CLIENT_SECRET}`);
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          scope: 'conversation:messages:create integration:openMessaging'
        })
    });
    if (!response.ok) throw new Error(`Token failed: ${response.status}`);
    const data = await response.json();
    return data.access_token;
}

async function handleSendToGenesys(request, env) {
    try {
    const rawBody = await request.text();
    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      // Tolerate payloads wrapped in single quotes from some shell invocations
      const normalized = rawBody.trim().replace(/^'/, '').replace(/'$/, '');
      body = JSON.parse(normalized);
    }

        const { text, visitorId } = body;
    if (!text || !visitorId) {
      return new Response('Missing required fields: text, visitorId', { status: 400 });
    }

        if (!env.INTEGRATION_ID) {
          return new Response('Missing Worker secret: INTEGRATION_ID', { status: 500 });
        }

        const token = await getAccessToken(env);
        await env.MESSAGES.put('__lastVisitorId', visitorId, { expirationTtl: 3600 });
        await setTypingState(env, visitorId, false, 'customer');
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

        const endpoint = `${getGenesysApiUrl(env)}/api/v2/conversations/messages/${env.INTEGRATION_ID}/inbound/open/message`;
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
      return new Response(`send-to-genesys failed: ${err.message}`, { status: 500 });
    }
}

async function handleSendTypingToGenesys(request, env) {
    try {
      const body = await request.json();
      const { visitorId, isTyping } = body || {};

      if (!visitorId || typeof isTyping !== 'boolean') {
        return new Response('Missing required fields: visitorId, isTyping(boolean)', { status: 400 });
      }

      if (!env.MESSAGES) return new Response('Missing KV binding: MESSAGES', { status: 500 });
      await env.MESSAGES.put('__lastVisitorId', visitorId, { expirationTtl: 3600 });
      await setTypingState(env, visitorId, isTyping, 'customer');

      // Genesys Open Messaging typing events are "start typing" events.
      // No explicit stop event is required by the inbound open event API.
      if (!isTyping) {
        return new Response('OK', { status: 200 });
      }

      const nowMs = Date.now();
      const lastSentRaw = await env.MESSAGES.get(`__typingLastSent:${visitorId}`);
      const lastSentMs = lastSentRaw ? parseInt(lastSentRaw, 10) : 0;
      if (Number.isFinite(lastSentMs) && nowMs - lastSentMs < 5000) {
        return new Response('OK', { status: 200 });
      }
      await env.MESSAGES.put(`__typingLastSent:${visitorId}`, String(nowMs), { expirationTtl: 120 });

      try {
        const token = await getAccessToken(env);
        const now = new Date().toISOString();
        const eventId = `${visitorId}-typing-${crypto.randomUUID()}`;
        const payload = {
          channel: {
            platform: 'Open',
            type: 'Private',
            messageId: eventId,
            to: { id: env.INTEGRATION_ID },
            from: { id: visitorId, idType: 'Opaque' },
            time: now
          },
          type: 'Event',
          event: {
            eventType: 'Typing'
          }
        };
        const endpoint = `${getGenesysApiUrl(env)}/api/v2/conversations/messages/inbound/open/event`;
        await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
      } catch {
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      return new Response(`send-typing failed: ${err.message}`, { status: 500 });
    }
}

async function handleGenesysWebhook(request, env) {
    try {
        if (!env.GENESYS_WEBHOOK_SECRET) {
          return new Response('Missing Worker secret: GENESYS_WEBHOOK_SECRET', { status: 500 });
        }

        const signatureHeader = request.headers.get('X-Hub-Signature-256');
        const rawBody = await request.text();
        const validSignature = await validateWebhookSignature(rawBody, signatureHeader, env.GENESYS_WEBHOOK_SECRET);
        if (!validSignature) {
          return new Response('Invalid webhook signature', { status: 401 });
        }

        const body = JSON.parse(rawBody);
        console.log('webhook received:', JSON.stringify(body));

        const direction = body.direction || body.event?.direction || body.body?.direction;
        const text = body.text || body.event?.text || body.body?.text;
        const typingState = extractTypingState(body);
        const typingEvent = matchesTypingEvent(body);
        const typingRaw =
          body?.event?.eventType ||
          body?.eventType ||
          body?.body?.event?.eventType ||
          body?.typing?.state ||
          body?.event?.typing?.state ||
          body?.body?.typing?.state ||
          body?.typingState ||
          body?.event?.typingState ||
          body?.body?.typingState ||
          body?.status ||
          body?.event?.status ||
          body?.body?.status ||
          null;

        if (typingEvent || (direction === 'Outbound' && typingState !== null)) {
            const typingCandidates = collectCandidateVisitorIds(body);
            if (typingCandidates.length === 0) {
              const lastVisitorId = await env.MESSAGES.get('__lastVisitorId');
              if (lastVisitorId) typingCandidates.push(lastVisitorId);
            }
            for (const visitorId of typingCandidates) {
              // Outbound typing is ephemeral: expire automatically if no follow-up typing event arrives.
              await setTypingState(env, visitorId, true, 'agent', 8);
            }
        }

        if (direction === 'Outbound' && text) {
            if (!env.MESSAGES) {
              return new Response('Missing KV binding: MESSAGES', { status: 500 });
            }

            const agentName = extractAgentDisplayName(body);

            const candidates = collectCandidateVisitorIds(body);
            if (candidates.length === 0) {
              const lastVisitorId = await env.MESSAGES.get('__lastVisitorId');
              if (lastVisitorId) candidates.push(lastVisitorId);
            }

            if (candidates.length === 0) {
              await env.MESSAGES.put('__orphanWebhook', JSON.stringify({
                at: new Date().toISOString(),
                reason: 'no-visitor-id-found',
                payload: body
              }), { expirationTtl: 3600 });
            } else {
              for (const visitorId of candidates) {
                await setTypingState(env, visitorId, false, 'agent', 30);
                await appendReplyWithName(env, visitorId, text, agentName);
              }
            }
        }

        await env.MESSAGES.put('__lastWebhookTyping', JSON.stringify({
          at: new Date().toISOString(),
          direction,
          typingRaw,
          typingState,
          candidateCount: collectCandidateVisitorIds(body).length
        }), { expirationTtl: 3600 });

        return new Response('OK', { status: 200 });
    } catch (err) {
        console.error('webhook error', err.message);
        return new Response(err.message, { status: 500 });
    }
}

async function handleDebugWebhook(env) {
  if (!env.MESSAGES) {
    return new Response(JSON.stringify({
      uiVersion: UI_VERSION,
      error: 'Missing KV binding: MESSAGES'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const orphan = await env.MESSAGES.get('__orphanWebhook');
  const lastVisitorId = await env.MESSAGES.get('__lastVisitorId');
  const lastMessages = lastVisitorId ? await env.MESSAGES.get(lastVisitorId) : null;
  const typing = lastVisitorId ? await getTypingState(env, lastVisitorId) : { isTyping: false, source: null };
  const lastWebhookTyping = await env.MESSAGES.get('__lastWebhookTyping');

  return new Response(JSON.stringify({
    uiVersion: UI_VERSION,
    lastVisitorId: lastVisitorId || null,
    hasLastMessages: Boolean(lastMessages),
    typing,
    lastWebhookTyping: lastWebhookTyping ? JSON.parse(lastWebhookTyping) : null,
    orphanWebhook: orphan ? JSON.parse(orphan) : null
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleGetMessages(request, env) {
    const url = new URL(request.url);
    const visitorId = url.searchParams.get('visitorId');
    const after = parseInt(url.searchParams.get('after') || '0');

    if (!visitorId) return new Response('Missing visitorId', { status: 400 });
  if (!env.MESSAGES) return new Response('Missing KV binding: MESSAGES', { status: 500 });

  const existing = await env.MESSAGES.get(visitorId);
    const msgs = existing ? JSON.parse(existing) : [];
    const newMsgs = msgs.slice(after);
    const typing = await getTypingState(env, visitorId);

    return new Response(JSON.stringify({ messages: newMsgs, total: msgs.length, typing }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handleHealthConfig(env) {
  const hasClientId = Boolean(env.GENESYS_CLIENT_ID);
  const hasClientSecret = Boolean(env.GENESYS_CLIENT_SECRET);
  const hasIntegrationId = Boolean(env.INTEGRATION_ID);
  const hasWebhookSecret = Boolean(env.GENESYS_WEBHOOK_SECRET);
  const hasMessagesKv = Boolean(env.MESSAGES);

  const ok = hasClientId && hasClientSecret && hasIntegrationId && hasWebhookSecret && hasMessagesKv;

  return new Response(JSON.stringify({
    ok,
    uiVersion: UI_VERSION,
    config: {
      genesysApiUrl: getGenesysApiUrl(env),
      hasClientId,
      hasClientSecret,
      hasIntegrationId,
      hasWebhookSecret,
      hasMessagesKv
    }
  }), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' }
  });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Support Chat</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }

  .chat-wrapper { width: 420px; max-width: 100vw; height: 680px; display: flex; flex-direction: column; border-radius: 16px; overflow: hidden; box-shadow: 0 8px 32px rgba(0,0,0,0.18); }

  /* Header */
  .chat-header { background: linear-gradient(135deg, #0f4c81, #1a73e8); padding: 16px 20px; display: flex; align-items: center; gap: 12px; }
  .avatar { width: 44px; height: 44px; border-radius: 50%; background: #fff; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
  .header-info { flex: 1; }
  .header-name { color: #fff; font-weight: 700; font-size: 16px; }
  .header-status { color: #b3d4ff; font-size: 12px; display: flex; align-items: center; gap: 5px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; display: inline-block; }
  .header-close { color: #b3d4ff; cursor: pointer; font-size: 20px; line-height: 1; }

  /* Messages */
  .chat-messages { flex: 1; overflow-y: auto; padding: 16px; background: #f8f9fb; display: flex; flex-direction: column; gap: 10px; }
  .chat-messages::-webkit-scrollbar { width: 4px; }
  .chat-messages::-webkit-scrollbar-thumb { background: #ccc; border-radius: 2px; }

  /* Bubbles */
  .msg-row { display: flex; align-items: flex-end; gap: 8px; }
  .msg-row.outgoing { flex-direction: row-reverse; }
  .msg-avatar { width: 30px; height: 30px; border-radius: 50%; background: #1a73e8; color: #fff; display: flex; align-items: center; justify-content: font-size:11px; font-size: 11px; font-weight: 700; flex-shrink: 0; align-items: center; justify-content: center; }
  .msg-avatar.you-avatar { background: #e8f0fe; color: #1a73e8; }
  .bubble { max-width: 75%; padding: 10px 14px; border-radius: 18px; font-size: 14px; line-height: 1.45; word-break: break-word; }
  .incoming .bubble { background: #fff; color: #1a1a1a; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .outgoing .bubble { background: #1a73e8; color: #fff; border-bottom-right-radius: 4px; }
  .bubble-meta { font-size: 11px; margin-top: 4px; opacity: 0.65; }
  .incoming .bubble-meta { text-align: left; color: #555; }
  .outgoing .bubble-meta { text-align: right; color: #c8deff; }

  /* System message */
  .sys-msg { text-align: center; font-size: 12px; color: #999; padding: 4px 0; }

  /* Typing indicator */
  .typing-row { display: flex; align-items: flex-end; gap: 8px; }
  .typing-bubble { background: #fff; border-radius: 18px; border-bottom-left-radius: 4px; padding: 10px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); display: flex; gap: 4px; align-items: center; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #a0a0a0; animation: bounce 1.2s infinite; }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-6px); } }

  /* Input area */
  .chat-footer { background: #fff; padding: 12px 16px; border-top: 1px solid #e8e8e8; display: flex; align-items: flex-end; gap: 10px; }
  #msg { flex: 1; border: 1.5px solid #e0e0e0; border-radius: 24px; padding: 10px 16px; font-size: 14px; resize: none; outline: none; max-height: 100px; line-height: 1.4; transition: border-color 0.2s; font-family: inherit; }
  #msg:focus { border-color: #1a73e8; }
  #sendBtn { width: 42px; height: 42px; border-radius: 50%; background: #1a73e8; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.2s; }
  #sendBtn:hover { background: #1558b0; }
  #sendBtn:disabled { background: #c5d9f7; cursor: default; }
  #sendBtn svg { width: 20px; height: 20px; fill: #fff; }

  /* Status bar */
  .status-bar { background: #fff; padding: 6px 16px; border-top: 1px solid #f0f0f0; font-size: 11px; color: #aaa; text-align: center; }
  .debug-row { background: #fff; border-top: 1px solid #f3f3f3; padding: 6px 12px; display: flex; justify-content: center; }
  .debug-pill { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #e4e8f2; border-radius: 999px; padding: 4px 10px; font-size: 11px; color: #556; background: #f7f9ff; }
  .dot-mini { width: 8px; height: 8px; border-radius: 50%; background: #9aa3b2; }
  .dot-mini.agent { background: #20b26b; }
  .dot-mini.customer { background: #1a73e8; }
  .dot-mini.off { background: #9aa3b2; }
</style>
</head>
<body>
<div class="chat-wrapper">
  <div class="chat-header">
    <div class="avatar">💬</div>
    <div class="header-info">
      <div class="header-name">Support Agent</div>
      <div class="header-status"><span class="status-dot"></span> Online · Genesys Cloud</div>
    </div>
  </div>

  <div class="chat-messages" id="chat">
    <div class="sys-msg">Chat started — we'll respond shortly</div>
  </div>

  <div class="chat-footer">
    <textarea id="msg" rows="1" placeholder="Type a message…" oninput="autoResize(this);handleTypingInput();" onkeydown="if(event.key==='Enter' && !event.shiftKey){event.preventDefault();send();}"></textarea>
    <button id="sendBtn" onclick="send()" title="Send">
      <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
    </button>
  </div>
  <div class="status-bar" id="statusBar">Connecting… (UI ${UI_VERSION})</div>
  <div class="debug-row">
    <div class="debug-pill" id="typingDebug"><span class="dot-mini off" id="typingDot"></span><span id="typingText">typing: off</span></div>
  </div>
</div>

<script>
  const visitorId = 'visitor-' + Math.random().toString(36).slice(2, 9);
  let seenCount = 0;
  let typingTimer = null;
  let connected = false;
  let localTypingSent = false;

  function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 100) + 'px';
  }

  function formatTime(iso) {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function appendBubble(sender, text, type, timestamp) {
    const chat = document.getElementById('chat');
    const isOut = type === 'outgoing';
    const row = document.createElement('div');
    row.className = 'msg-row ' + type;
    const avatarLabel = isOut ? 'Me' : 'AG';
    const avatarClass = isOut ? 'you-avatar' : '';
    row.innerHTML =
      '<div class="msg-avatar ' + avatarClass + '">' + avatarLabel + '</div>' +
      '<div>' +
        '<div class="bubble">' + escapeHtml(text) + '</div>' +
        '<div class="bubble-meta">' + (isOut ? 'You' : sender) + ' · ' + formatTime(timestamp) + '</div>' +
      '</div>';
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }

  function showTyping() {
    removeTyping();
    const chat = document.getElementById('chat');
    const row = document.createElement('div');
    row.className = 'typing-row'; row.id = 'typingIndicator';
    row.innerHTML = '<div class="msg-avatar">AG</div><div class="typing-bubble"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;
  }

  function removeTyping() {
    const el = document.getElementById('typingIndicator');
    if (el) el.remove();
  }

  function escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function setStatus(text) {
    document.getElementById('statusBar').textContent = text;
  }

  function setTypingDebug(isTyping, source) {
    const dot = document.getElementById('typingDot');
    const text = document.getElementById('typingText');
    const src = source || 'none';
    dot.className = 'dot-mini ' + (isTyping ? (src === 'agent' ? 'agent' : 'customer') : 'off');
    text.textContent = 'typing: ' + (isTyping ? 'on' : 'off') + ' (' + src + ')';
  }

  async function send() {
    const input = document.getElementById('msg');
    const btn = document.getElementById('sendBtn');
    const text = input.value.trim();
    if (!text) return;

    appendBubble('You', text, 'outgoing');
    input.value = ''; input.style.height = 'auto';
    btn.disabled = true;

    try {
      const res = await fetch('/send-to-genesys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, visitorId })
      });
      if (res.ok) {
        setStatus('Message sent · Waiting for agent reply…');
        await sendTyping(false);
      } else {
        const reason = await res.text();
        setStatus('Send failed (' + res.status + '): ' + reason);
      }
    } catch (e) {
      setStatus('Network error — check connection');
    }
    btn.disabled = false;
    input.focus();
  }

  async function sendTyping(isTyping) {
    if (isTyping === localTypingSent) return;
    localTypingSent = isTyping;
    try {
      await fetch('/send-typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId, isTyping })
      });
    } catch { }
  }

  function handleTypingInput() {
    const value = document.getElementById('msg').value.trim();
    sendTyping(value.length > 0);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => sendTyping(false), 1500);
  }

  async function pollReplies() {
    try {
      const res = await fetch('/get-messages?visitorId=' + visitorId + '&after=' + seenCount);
      if (!res.ok) return;
      const data = await res.json();
      if (!connected) { connected = true; setStatus('Connected · Visitor ID: ' + visitorId + ' · UI ${UI_VERSION}'); }
      if (data.typing && data.typing.isTyping && data.typing.source === 'agent') {
        showTyping();
        setTypingDebug(true, data.typing.source);
      } else {
        removeTyping();
        setTypingDebug(Boolean(data.typing && data.typing.isTyping), data.typing ? data.typing.source : 'none');
      }
      if (data.messages && data.messages.length > 0) {
        removeTyping();
        data.messages.forEach(m => appendBubble(m.agentName || 'Agent', m.text, 'incoming', m.timestamp));
        seenCount = data.total;
        setStatus('Agent replied · ' + formatTime());
      }
    } catch (e) { setStatus('Polling error — retrying…'); }
  }

  setInterval(pollReplies, 2000);
  setTimeout(() => { if (!connected) setStatus('Ready · Visitor ID: ' + visitorId + ' · UI ${UI_VERSION}'); }, 2000);
</script>
</body>
</html>`;

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const pathname = url.pathname;

    if (method === 'POST' && pathname === '/send-to-genesys') return handleSendToGenesys(request, env);
    if (method === 'POST' && pathname === '/send-typing') return handleSendTypingToGenesys(request, env);
    if (method === 'POST' && pathname === '/genesys-webhook') return handleGenesysWebhook(request, env);
    if (method === 'GET' && pathname === '/get-messages') return handleGetMessages(request, env);
    if (method === 'GET' && pathname === '/health-config') return handleHealthConfig(env);
    if (method === 'GET' && pathname === '/debug-webhook') return handleDebugWebhook(env);
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return new Response(PAGE_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=UTF-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        }
      });
    }

    return new Response('Not Found', { status: 404 });
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  }
};
