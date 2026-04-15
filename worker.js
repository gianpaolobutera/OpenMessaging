// Cloud mode only: Worker uses Cloudflare bindings (not local .env file).
// Secrets in Cloudflare dashboard: GENESYS_CLIENT_ID, GENESYS_CLIENT_SECRET, INTEGRATION_ID
// KV binding in Cloudflare dashboard: MESSAGES

const UI_VERSION = '2026-04-07.4';
const MIN_KV_TTL_SECONDS = 60;
const AGENT_TYPING_UI_WINDOW_SECONDS = 10;
const LAR_THREADING_TTL_SECONDS = 72 * 60 * 60;

function getGenesysApiUrl(env) {
  return env.GENESYS_API_URL || 'https://api.euc2.pure.cloud';
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function isKvPutLimitError(err) {
  const msg = err && err.message ? String(err.message) : '';
  return /kv put\(\) limit exceeded/i.test(msg);
}

function hasMessageStore(env) {
  return Boolean(env && (env.CHAT_STATE || env.MESSAGES));
}

function getChatStateStub(env) {
  if (!env || !env.CHAT_STATE) return null;
  const id = env.CHAT_STATE.idFromName('global-chat-state');
  return env.CHAT_STATE.get(id);
}

async function kvGet(env, key) {
  if (!env || !key) return null;

  const stub = getChatStateStub(env);
  if (stub) {
    const res = await stub.fetch(`https://chat-state/get?key=${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const reason = await res.text();
      throw new Error(`CHAT_STATE get failed: ${res.status} ${reason}`);
    }
    return await res.text();
  }

  if (!env.MESSAGES) return null;
  return env.MESSAGES.get(key);
}

async function kvPut(env, key, value, options) {
  if (!env || !key) return false;

  const stub = getChatStateStub(env);
  if (stub) {
    const res = await stub.fetch('https://chat-state/put', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        value,
        expirationTtl: options && options.expirationTtl ? options.expirationTtl : null
      })
    });
    if (!res.ok) {
      const reason = await res.text();
      throw new Error(`CHAT_STATE put failed: ${res.status} ${reason}`);
    }
    return true;
  }

  if (!env.MESSAGES) return false;
  await env.MESSAGES.put(key, value, options);
  return true;
}

async function kvDelete(env, key) {
  if (!env || !key) return false;

  const stub = getChatStateStub(env);
  if (stub) {
    const res = await stub.fetch('https://chat-state/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key })
    });
    if (!res.ok) {
      const reason = await res.text();
      throw new Error(`CHAT_STATE delete failed: ${res.status} ${reason}`);
    }
    return true;
  }

  if (!env.MESSAGES) return false;
  await env.MESSAGES.delete(key);
  return true;
}

async function safeKvPut(env, key, value, options) {
  if (!hasMessageStore(env)) return false;
  try {
    return await kvPut(env, key, value, options);
  } catch (err) {
    if (isKvPutLimitError(err)) {
      console.warn(`KV quota reached; skipping write for key ${key}`);
      return false;
    }
    throw err;
  }
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
  const existing = await kvGet(env, visitorId);
  const msgs = existing ? JSON.parse(existing) : [];
  msgs.push({ text, timestamp: new Date().toISOString(), agentName: 'Agent' });
  await safeKvPut(env, visitorId, JSON.stringify(msgs), { expirationTtl: 3600 });
}

function extractAgentDisplayName(payload) {
  const candidates = [
    payload?.channel?.from?.nickname,
    payload?.channel?.from?.name,
    payload?.channel?.from?.displayName,
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
    payload?.body?.agent?.displayName,
    payload?.event?.channel?.from?.nickname,
    payload?.event?.channel?.from?.name,
    payload?.event?.channel?.from?.displayName,
    payload?.body?.channel?.from?.nickname,
    payload?.body?.channel?.from?.name,
    payload?.body?.channel?.from?.displayName
  ];

  for (const name of candidates) {
    if (typeof name === 'string' && name.trim()) return name.trim();
  }
  return 'Agent';
}

async function appendReplyWithName(env, visitorId, text, agentName) {
  const existing = await kvGet(env, visitorId);
  let msgs = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      msgs = Array.isArray(parsed) ? parsed : [];
    } catch {
      msgs = [];
    }
  }
  msgs.push({
    text,
    timestamp: new Date().toISOString(),
    agentName: agentName || 'Agent'
  });
  await safeKvPut(env, visitorId, JSON.stringify(msgs), { expirationTtl: 3600 });
}

async function setTypingState(env, visitorId, isTyping, source, ttlSeconds = 120, durationMs = null) {
  const safeTtl = Math.max(MIN_KV_TTL_SECONDS, Number(ttlSeconds) || 0);
  const payload = {
    isTyping: Boolean(isTyping),
    source: source || 'unknown',
    at: new Date().toISOString()
  };
  if (Number.isFinite(Number(durationMs)) && Number(durationMs) > 0) {
    payload.durationMs = Number(durationMs);
  }
  await safeKvPut(env, `__typing:${visitorId}`, JSON.stringify(payload), { expirationTtl: safeTtl });
}

function matchesTypingEvent(payload) {
  const eventLists = [
    payload?.events,
    payload?.event?.events,
    payload?.body?.events,
    payload?.body?.event?.events
  ];

  for (const list of eventLists) {
    if (!Array.isArray(list)) continue;
    for (const event of list) {
      if (typeof event?.eventType === 'string' && event.eventType.toLowerCase() === 'typing') {
        return true;
      }
    }
  }

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

function bytesToBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function toBase64Url(value) {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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
  const macBytes = new Uint8Array(mac);
  const expectedHex = bytesToHex(macBytes);
  const expectedBase64 = bytesToBase64(macBytes);
  const expectedBase64Url = toBase64Url(expectedBase64);

  const candidate = normalizedSignature.trim();
  const candidateLower = candidate.toLowerCase();

  return (
    constantTimeEqual(expectedHex, candidateLower) ||
    constantTimeEqual(expectedBase64, candidate) ||
    constantTimeEqual(expectedBase64Url, candidate)
  );
}

function validateDataActionSecret(request, env) {
  const expected = (env.DATA_ACTION_SHARED_SECRET || '').trim();
  if (!expected) return false;
  const provided = (request.headers.get('X-Webhook-Key') || '').trim();
  return provided && constantTimeEqual(expected, provided);
}

async function getTypingState(env, visitorId) {
  const raw = await kvGet(env, `__typing:${visitorId}`);
  if (!raw) return { isTyping: false, source: null };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.isTyping && parsed.source === 'agent' && parsed.at) {
      const ageMs = Date.now() - Date.parse(parsed.at);
      const configuredWindowMs = AGENT_TYPING_UI_WINDOW_SECONDS * 1000;
      const effectiveWindowMs = Number.isFinite(Number(parsed.durationMs))
        ? Math.max(1000, Number(parsed.durationMs))
        : configuredWindowMs;
      if (Number.isFinite(ageMs) && ageMs > effectiveWindowMs) {
        return { isTyping: false, source: 'agent', at: parsed.at, expired: true };
      }
    }
    return parsed;
  } catch {
    return { isTyping: false, source: null };
  }
}

async function postTypingEventToGenesys(env, token, visitorId, visitorNickname) {
  const now = new Date().toISOString();
  const endpoint = `${getGenesysApiUrl(env)}/api/v2/conversations/messages/${env.INTEGRATION_ID}/inbound/open/event`;
  const payload = {
    channel: {
      from: {
        id: visitorId,
        idType: 'Opaque',
        nickname: visitorNickname || 'Customer'
      },
      time: now
    },
    events: [
      {
        eventType: 'Typing'
      }
    ]
  };

  if (endpoint.includes('/undefined/')) {
    return {
      ok: false,
      attempts: [{
        label: 'open-event-integration',
        endpoint,
        status: 0,
        ok: false,
        body: 'Missing INTEGRATION_ID'
      }]
    };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await res.text();
  return {
    ok: res.ok,
    attempts: [{
      label: 'open-event-integration',
      endpoint,
      status: res.status,
      ok: res.ok,
      body: bodyText.slice(0, 500)
    }]
  };
}

async function postDisconnectEventToGenesys(env, token, visitorId, visitorNickname, conversationId = null) {
  const now = new Date().toISOString();
  const messageId = `${visitorId}-disconnect-${crypto.randomUUID()}`;
  const targetId = conversationId || env.INTEGRATION_ID;
  const endpoint = `${getGenesysApiUrl(env)}/api/v2/conversations/messages/${targetId}/inbound/open/message`;
  const customAttributes = {
    visitorId,
    status: 'disconnect-customer'
  };
  const basePayload = {
    id: messageId,
    channel: {
      id: env.INTEGRATION_ID,
      platform: 'Open',
      type: 'Private',
      messageId,
      to: {
        id: env.INTEGRATION_ID
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
      label: 'channel.metadata.customAttributes.no-to:text-empty',
      payload: {
        ...basePayload,
        channel: {
          ...basePayload.channel,
          to: undefined
        }
      }
    },
    {
      label: 'channel.metadata.customAttributes.no-to:text-space',
      payload: {
        ...basePayload,
        text: ' ',
        channel: {
          ...basePayload.channel,
          to: undefined
        }
      }
    },
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

  if (endpoint.includes('/undefined/')) {
    return {
      ok: false,
      attempts: [{
        label: 'open-message-disconnect',
        endpoint,
        status: 0,
        ok: false,
        body: 'Missing INTEGRATION_ID'
      }]
    };
  }

  const attempts = [];
  let accepted = false;

  for (const variant of payloadVariants) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(variant.payload)
    });

    const bodyText = await res.text();
    attempts.push({
      label: `open-message-disconnect:${variant.label}`,
      endpoint,
      status: res.status,
      ok: res.ok,
      body: bodyText.slice(0, 500)
    });

    if (res.ok) {
      accepted = true;
      break;
    }
  }

  return {
    ok: accepted,
    attempts
  };
}

function extractTypingState(payload) {
  const eventLists = [
    payload?.events,
    payload?.event?.events,
    payload?.body?.events,
    payload?.body?.event?.events
  ];

  for (const list of eventLists) {
    if (!Array.isArray(list)) continue;
    for (const event of list) {
      if (typeof event?.eventType === 'string' && event.eventType.toLowerCase() === 'typing') {
        const typeRaw = event?.typing?.type || event?.typing?.state || 'On';
        const normalizedType = String(typeRaw).toLowerCase();
        if (['off', 'stop', 'stopped', 'false', 'idle'].includes(normalizedType)) return false;
        return true;
      }
    }
  }

  const raw =
    payload?.typing?.state ||
    payload?.typing?.type ||
    payload?.event?.typing?.state ||
    payload?.event?.typing?.type ||
    payload?.body?.typing?.state ||
    payload?.body?.typing?.type ||
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

function extractTypingDurationMs(payload) {
  const eventLists = [
    payload?.events,
    payload?.event?.events,
    payload?.body?.events,
    payload?.body?.event?.events
  ];

  for (const list of eventLists) {
    if (!Array.isArray(list)) continue;
    for (const event of list) {
      if (typeof event?.eventType === 'string' && event.eventType.toLowerCase() === 'typing') {
        const duration = Number(event?.typing?.duration);
        if (Number.isFinite(duration) && duration > 0) {
          return Math.max(1000, Math.min(60000, duration));
        }
      }
    }
  }

  return null;
}

function findFirstTextValue(value, path = 'root', depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? { text: trimmed, path } : null;
  }
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = findFirstTextValue(value[i], `${path}[${i}]`, depth + 1, seen);
      if (hit) return hit;
    }
    return null;
  }

  const priorityKeys = ['text', 'message', 'content', 'body', 'value'];
  for (const key of priorityKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const hit = findFirstTextValue(value[key], `${path}.${key}`, depth + 1, seen);
      if (hit) return hit;
    }
  }

  const ignoredKeys = new Set([
    'eventType',
    'type',
    'status',
    'direction',
    'id',
    'idType',
    'platform',
    'messageId',
    'conversationId',
    'channel'
  ]);

  for (const [k, v] of Object.entries(value)) {
    if (ignoredKeys.has(k)) continue;
    const hit = findFirstTextValue(v, `${path}.${k}`, depth + 1, seen);
    if (hit) return hit;
  }
  return null;
}

function isNonMessageTextPath(path) {
  if (!path || typeof path !== 'string') return false;
  return /(eventType|\.type$|\.status$|\.direction$|\.id$|\.idType$|\.platform$|\.messageId$|\.conversationId$)/i.test(path);
}

function extractWebhookText(payload) {
  const candidates = [
    ['text', payload?.text],
    ['messageText', payload?.messageText],
    ['body.messageText', payload?.body?.messageText],
    ['event.messageText', payload?.event?.messageText],
    ['data.messageText', payload?.data?.messageText],
    ['event.data.messageText', payload?.event?.data?.messageText],
    ['event.text', payload?.event?.text],
    ['body.text', payload?.body?.text],
    ['message.text', payload?.message?.text],
    ['message.body', payload?.message?.body],
    ['content.text', payload?.content?.text],
    ['event.message.text', payload?.event?.message?.text],
    ['event.message.body', payload?.event?.message?.body],
    ['event.content.text', payload?.event?.content?.text],
    ['event.body.text', payload?.event?.body?.text],
    ['body.message.text', payload?.body?.message?.text],
    ['body.message.body', payload?.body?.message?.body],
    ['body.content.text', payload?.body?.content?.text],
    ['body.event.message.text', payload?.body?.event?.message?.text],
    ['body.event.content.text', payload?.body?.event?.content?.text],
    ['channel.message.text', payload?.channel?.message?.text]
  ];

  for (const [path, value] of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return { text: value.trim(), textPath: path };
    }
  }

  const deepSearchRoots = [
    ['event', payload?.event],
    ['body', payload?.body],
    ['message', payload?.message],
    ['content', payload?.content]
  ];

  for (const [path, node] of deepSearchRoots) {
    const hit = findFirstTextValue(node, path);
    if (hit && !isNonMessageTextPath(hit.path)) return { text: hit.text, textPath: hit.path };
  }

  return { text: null, textPath: null };
}

function collectOutboundTargetVisitorIds(payload) {
  const candidates = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim()) candidates.add(v.trim());
  };

  // Prefer recipient/customer fields for outbound events.
  add(payload?.channel?.to?.id);
  add(payload?.event?.channel?.to?.id);
  add(payload?.body?.channel?.to?.id);
  add(payload?.metadata?.visitorId);
  add(payload?.event?.metadata?.visitorId);
  add(payload?.body?.metadata?.visitorId);

  return Array.from(candidates);
}

function resolveOutboundVisitorIds(payload, env, lastVisitorId) {
  const preferred = collectOutboundTargetVisitorIds(payload);
  const all = collectCandidateVisitorIds(payload);
  const integrationId = (env?.INTEGRATION_ID || '').trim();
  const normalizedLastVisitorId = typeof lastVisitorId === 'string' ? lastVisitorId.trim() : '';

  const preferredFiltered = preferred.filter((id) => id && id !== integrationId);
  if (preferredFiltered.length > 0) {
    if (normalizedLastVisitorId && preferredFiltered.includes(normalizedLastVisitorId)) {
      return [normalizedLastVisitorId, ...preferredFiltered.filter((id) => id !== normalizedLastVisitorId)];
    }
    return preferredFiltered;
  }

  // When outbound payload is ambiguous, stick to the active chat visitor instead of agent/system ids.
  if (normalizedLastVisitorId) {
    return [normalizedLastVisitorId];
  }

  const merged = Array.from(new Set(all));
  const scored = merged
    .filter((id) => id && id !== integrationId)
    .map((id) => {
      let score = 0;
      if (/^visitor[-_]/i.test(id)) score += 30;
      if (id === payload?.metadata?.visitorId) score += 20;
      if (id === payload?.event?.metadata?.visitorId) score += 20;
      if (id === payload?.body?.metadata?.visitorId) score += 20;
      if (id === payload?.channel?.to?.id) score += 15;
      if (id === payload?.event?.channel?.to?.id) score += 15;
      if (id === payload?.body?.channel?.to?.id) score += 15;
      return { id, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked = scored.map((s) => s.id);
  if (picked.length > 0) return picked;
  return [];
}

function isDisconnectLikeWebhook(payload) {
  const values = [
    payload?.type,
    payload?.status,
    payload?.eventType,
    payload?.event?.eventType,
    payload?.body?.eventType,
    payload?.body?.event?.eventType,
    payload?.event?.type,
    payload?.body?.event?.type
  ]
    .filter((v) => typeof v === 'string')
    .map((v) => v.toLowerCase());

  return values.some((v) =>
    v.includes('disconnect') ||
    v.includes('disconnected') ||
    v.includes('left the conversation') ||
    v.includes('agent left') ||
    v.includes('terminate') ||
    v.includes('ended') ||
    v.includes('closed')
  );
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

        const {
          text,
          visitorId,
          visitorNickname,
          visitorFirstName,
          visitorLastName,
          seedParticipantData,
          participantAttributes
        } = body;
    if (!text || !visitorId) {
      return new Response('Missing required fields: text, visitorId', { status: 400 });
    }

        if (!env.INTEGRATION_ID) {
          return new Response('Missing Worker secret: INTEGRATION_ID', { status: 500 });
        }

        const token = await getAccessToken(env);
        await safeKvPut(env, '__lastVisitorId', visitorId, { expirationTtl: 3600 });
        await setTypingState(env, visitorId, false, 'customer');
        const firstEventMarkerKey = `__convInit:${visitorId}`;
        const conversationIdKey = `__convId:${visitorId}`;
        const knownConversationId = await kvGet(env, conversationIdKey);
        const markerExists = Boolean(await kvGet(env, firstEventMarkerKey));
        const isFirstCustomerEvent = Boolean(seedParticipantData) || !markerExists;
        const shouldPrefetchConversationId = isFirstCustomerEvent && !knownConversationId;
        const now = new Date().toISOString();
        const messageId = `${visitorId}-${crypto.randomUUID()}`;

        const participantData = {
          visitorId,
          channel: 'open-messaging-webchat',
          uiVersion: UI_VERSION,
          conversationStartAt: now
        };

        const customAttributes = {
          ...(participantAttributes && typeof participantAttributes === 'object' ? participantAttributes : {}),
          visitorId
        };

        if (isFirstCustomerEvent) {
          customAttributes.channel = customAttributes.channel || participantData.channel;
          customAttributes.uiVersion = customAttributes.uiVersion || participantData.uiVersion;
          customAttributes.conversationStartAt = customAttributes.conversationStartAt || participantData.conversationStartAt;
        }

        const targetId = knownConversationId || env.INTEGRATION_ID;
        const endpointBase = `${getGenesysApiUrl(env)}/api/v2/conversations/messages/${targetId}/inbound/open/message`;
        const canPrefetchConversationId = !knownConversationId;
        const endpoint = (shouldPrefetchConversationId && canPrefetchConversationId)
          ? `${endpointBase}?prefetchConversationId=true`
          : endpointBase;

        const payload = {
            id: messageId,
            channel: {
                id: env.INTEGRATION_ID,
                platform: 'Open',
                type: 'Private',
                messageId,
                to: {
                  id: env.INTEGRATION_ID
                },
                from: {
                  id: visitorId,
                  idType: 'Opaque',
                  nickname: visitorNickname || 'Web Customer',
                  firstName: visitorFirstName || undefined,
                  lastName: visitorLastName || undefined
                },
                time: now,
                metadata: {
                  customAttributes
                }
            },
            type: 'Text',
            text
        };

        let payloadVariants = [
          {
            label: 'channel.metadata.customAttributes.no-to',
            payload: {
              ...payload,
              channel: {
                ...payload.channel,
                to: undefined
              }
            }
          },
          {
            label: 'channel.metadata.customAttributes',
            payload
          },
          {
            label: 'channel.customAttributes.no-to',
            payload: {
              ...payload,
              channel: {
                ...payload.channel,
                to: undefined,
                metadata: undefined,
                customAttributes
              }
            }
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

        if (isFirstCustomerEvent) {

          await safeKvPut(env, '__lastInitialEventSend', JSON.stringify({
            at: now,
            visitorId,
            skipped: true,
            reason: 'disabled-explicit-initial-event; using metadata/customAttributes on first message'
          }), { expirationTtl: 3600 });
        }

        let genesysResponse = null;
        let prefetchedConversationId = null;
        const attemptLog = [];
        for (let i = 0; i < payloadVariants.length; i += 1) {
          const variant = payloadVariants[i];

          const res = await fetch(endpoint, {
              method: 'POST',
              headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json'
              },
              body: JSON.stringify(variant.payload)
          });

          const bodyText = await res.text();
          let parsedBody = null;
          try {
            parsedBody = bodyText ? JSON.parse(bodyText) : null;
          } catch {
            parsedBody = null;
          }
          attemptLog.push({ variant: variant.label, status: res.status, ok: res.ok, body: bodyText.slice(0, 500) });
          genesysResponse = { status: res.status, ok: res.ok, bodyText, parsedBody };
          if (res.ok && parsedBody && typeof parsedBody.conversationId === 'string' && parsedBody.conversationId.trim()) {
            prefetchedConversationId = parsedBody.conversationId.trim();
          }
          if (res.ok) break;
        }

        await safeKvPut(env, '__lastFirstEventSeedAttempts', JSON.stringify({
          at: now,
          visitorId,
          isFirstCustomerEvent,
          attempts: attemptLog
        }), { expirationTtl: 3600 });

        if (genesysResponse && genesysResponse.ok) {
          if (prefetchedConversationId) {
            await safeKvPut(env, conversationIdKey, prefetchedConversationId, { expirationTtl: LAR_THREADING_TTL_SECONDS });
          }
          if (isFirstCustomerEvent) {
            // Keep first-message marker for the full threading window so re-chats don't get forced
            // into first-message logic while still inside the LAR timeline.
            await safeKvPut(env, firstEventMarkerKey, now, { expirationTtl: LAR_THREADING_TTL_SECONDS });
            const successAttempt = attemptLog.find((a) => a.ok) || null;
            await safeKvPut(env, '__lastParticipantDataSeed', JSON.stringify({
              at: now,
              visitorId,
              participantData,
              prefetchedConversationId,
              usedPrefetchConversationId: shouldPrefetchConversationId,
              successVariant: successAttempt ? successAttempt.variant : null,
              attemptsCount: attemptLog.length
            }), { expirationTtl: 3600 });
          }
          return new Response('OK', { status: 200 });
        }

        const errorData = genesysResponse ? genesysResponse.bodyText : 'No response from Genesys';
        const errorStatus = genesysResponse ? genesysResponse.status : 500;
        return new Response(errorData, { status: errorStatus });
    } catch (err) {
      return new Response(`send-to-genesys failed: ${err.message}`, { status: 500 });
    }
}

async function handleSendTypingToGenesys(request, env) {
    try {
      const body = await request.json();
      const { visitorId, isTyping, visitorNickname } = body || {};

      if (!visitorId || typeof isTyping !== 'boolean') {
        return new Response('Missing required fields: visitorId, isTyping(boolean)', { status: 400 });
      }

      if (!hasMessageStore(env)) return new Response('Missing message store binding: MESSAGES or CHAT_STATE', { status: 500 });
      await safeKvPut(env, '__lastVisitorId', visitorId, { expirationTtl: 3600 });
      await setTypingState(env, visitorId, isTyping, 'customer');

      // Genesys Open Messaging typing events are "start typing" events.
      // No explicit stop event is required by the inbound open event API.
      if (!isTyping) {
        return new Response('OK', { status: 200 });
      }

      const nowMs = Date.now();
      const lastSentRaw = await kvGet(env, `__typingLastSent:${visitorId}`);
      const lastSentMs = lastSentRaw ? parseInt(lastSentRaw, 10) : 0;
      if (Number.isFinite(lastSentMs) && nowMs - lastSentMs < 5000) {
        return new Response('OK', { status: 200 });
      }
      await safeKvPut(env, `__typingLastSent:${visitorId}`, String(nowMs), { expirationTtl: 120 });

      try {
        const token = await getAccessToken(env);
        const result = await postTypingEventToGenesys(env, token, visitorId, visitorNickname);
        await safeKvPut(env, '__lastCustomerTypingSend', JSON.stringify({
          at: new Date().toISOString(),
          visitorId,
          accepted: result.ok,
          attempts: result.attempts
        }), { expirationTtl: 3600 });
      } catch {
      }

      return new Response('OK', { status: 200 });
    } catch (err) {
      return new Response(`send-typing failed: ${err.message}`, { status: 500 });
    }
}

async function handleDisconnectCustomer(request, env) {
  try {
    const body = await request.json();
    const { visitorId, visitorNickname } = body || {};

    if (!visitorId) {
      return new Response('Missing required field: visitorId', { status: 400 });
    }

    if (!env.INTEGRATION_ID) {
      return new Response('Missing Worker secret: INTEGRATION_ID', { status: 500 });
    }

    await safeKvPut(env, '__lastVisitorId', visitorId, { expirationTtl: 3600 });
    await setTypingState(env, visitorId, false, 'customer');

    const token = await getAccessToken(env);
    const conversationId = await kvGet(env, `__convId:${visitorId}`);
    const result = await postDisconnectEventToGenesys(env, token, visitorId, visitorNickname, conversationId || null);

    await safeKvPut(env, '__lastCustomerDisconnectSend', JSON.stringify({
      at: new Date().toISOString(),
      visitorId,
      accepted: result.ok,
      attempts: result.attempts
    }), { expirationTtl: 3600 });

    if (!result.ok) {
      const detail = result.attempts && result.attempts[0] ? result.attempts[0].body : 'Unable to send disconnect event';
      return new Response(detail, { status: result.attempts && result.attempts[0] ? result.attempts[0].status || 502 : 502 });
    }

    if (hasMessageStore(env)) {
      await appendReplyWithName(env, visitorId, 'You disconnected the chat.', 'System');
    }

    return new Response('OK', { status: 200 });
  } catch (err) {
    return new Response(`disconnect-customer failed: ${err.message}`, { status: 500 });
  }
}

async function handleGenesysWebhook(request, env) {
    try {
        const signatureHeader = request.headers.get('X-Hub-Signature-256');
        const rawBody = await request.text();
        let authMode = null;

        if (env.GENESYS_WEBHOOK_SECRET) {
          const validSignature = await validateWebhookSignature(rawBody, signatureHeader, env.GENESYS_WEBHOOK_SECRET);
          if (validSignature) authMode = 'hmac';
        }

        if (!authMode && validateDataActionSecret(request, env)) {
          authMode = 'data-action-secret';
        }

        if (!authMode) {
          if (hasMessageStore(env)) {
            await safeKvPut(env, '__lastWebhookAuthFailure', JSON.stringify({
              at: new Date().toISOString(),
              hasSignatureHeader: Boolean(signatureHeader),
              hasDataActionHeader: Boolean(request.headers.get('X-Webhook-Key')),
              signaturePrefix: signatureHeader ? signatureHeader.slice(0, 24) : null,
              bodyLength: rawBody.length
            }), { expirationTtl: 3600 });
          }
          return jsonResponse({ ok: false, error: 'Invalid webhook signature' }, 401);
        }

        const body = JSON.parse(rawBody);
        console.log('webhook received:', JSON.stringify(body));

        const direction = body.direction || body.event?.direction || body.body?.direction || null;
        const msgType = (body.type || body.event?.type || body.body?.type || '').toString().toLowerCase();
        const eventType = (body.event?.eventType || body.eventType || body.body?.event?.eventType || '').toString().toLowerCase();
        const { text, textPath } = extractWebhookText(body);
        const typingState = extractTypingState(body);
        const typingDurationMs = extractTypingDurationMs(body);
        const typingEvent = matchesTypingEvent(body);
        const textLikeEvent = msgType === 'text' || eventType === 'message' || Boolean(text);
        const outboundLike = direction === 'Outbound' || textLikeEvent || typingEvent;
        const candidateCount = collectCandidateVisitorIds(body).length;
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

        if (hasMessageStore(env)) {
          await safeKvPut(env, '__lastWebhookEvent', JSON.stringify({
            at: new Date().toISOString(),
            authMode,
            direction,
            msgType,
            eventType,
            outboundLike,
            hasText: Boolean(text),
            textPath,
            bodyKeys: Object.keys(body || {}),
            typingRaw,
            typingState,
            typingDurationMs,
            candidateCount
          }), { expirationTtl: 3600 });

          if (outboundLike) {
            await safeKvPut(env, '__lastOutboundWebhookEvent', JSON.stringify({
              at: new Date().toISOString(),
              authMode,
              direction,
              msgType,
              eventType,
              hasText: Boolean(text),
              textPath,
              candidateCount,
              typingDurationMs,
              channelFromId: body?.channel?.from?.id || null,
              channelToId: body?.channel?.to?.id || null
            }), { expirationTtl: 3600 });
          }

          if (outboundLike && text) {
            await safeKvPut(env, '__lastOutboundTextWebhook', JSON.stringify({
              at: new Date().toISOString(),
              authMode,
              direction,
              msgType,
              eventType,
              text,
              textPath,
              candidateCount
            }), { expirationTtl: 3600 });
          }
        }

        if (typingEvent || (outboundLike && typingState !== null)) {
            const typingCandidates = collectCandidateVisitorIds(body);
            if (typingCandidates.length === 0) {
              const lastVisitorId = await kvGet(env, '__lastVisitorId');
              if (lastVisitorId) typingCandidates.push(lastVisitorId);
            }
            const isAgentTyping = typingState == null ? true : typingState;
            const typingTtlSeconds = isAgentTyping
              ? Math.max(5, Math.ceil((typingDurationMs || 5000) / 1000))
              : 60;
            for (const visitorId of typingCandidates) {
              await setTypingState(
                env,
                visitorId,
                isAgentTyping,
                'agent',
                typingTtlSeconds,
                isAgentTyping ? (typingDurationMs || 5000) : null
              );
            }
        }

        if (outboundLike && text) {
            if (!hasMessageStore(env)) {
              return new Response('Missing message store binding: MESSAGES or CHAT_STATE', { status: 500 });
            }

            const agentName = extractAgentDisplayName(body);
            const lastVisitorId = await kvGet(env, '__lastVisitorId');
            const candidates = resolveOutboundVisitorIds(body, env, lastVisitorId);

            if (candidates.length === 0) {
              await safeKvPut(env, '__orphanWebhook', JSON.stringify({
                at: new Date().toISOString(),
                reason: 'no-visitor-id-found',
                payload: body
              }), { expirationTtl: 3600 });
            } else {
              const appendResult = {
                at: new Date().toISOString(),
                candidates,
                lastVisitorId: lastVisitorId || null,
                appended: [],
                failed: []
              };
              for (const visitorId of candidates) {
                try {
                  await setTypingState(env, visitorId, false, 'agent', 60);
                  await appendReplyWithName(env, visitorId, text, agentName);
                  appendResult.appended.push(visitorId);
                } catch (e) {
                  appendResult.failed.push({ visitorId, error: e.message });
                }
              }
              await safeKvPut(env, '__lastAppendResult', JSON.stringify(appendResult), { expirationTtl: 3600 });
            }
        }

        const disconnectLike = isDisconnectLikeWebhook(body);
        if (disconnectLike && !text) {
            if (!hasMessageStore(env)) {
              return new Response('Missing message store binding: MESSAGES or CHAT_STATE', { status: 500 });
            }

            const lastVisitorId = await kvGet(env, '__lastVisitorId');
            const candidates = resolveOutboundVisitorIds(body, env, lastVisitorId);
            if (candidates.length > 0) {
              const agentName = extractAgentDisplayName(body);
              for (const visitorId of candidates) {
                await appendReplyWithName(
                  env,
                  visitorId,
                  `${agentName} disconnected the interaction.`,
                  'System'
                );
                await setTypingState(env, visitorId, false, 'agent', 60);
              }
              await safeKvPut(env, '__lastDisconnectEvent', JSON.stringify({
                at: new Date().toISOString(),
                candidates,
                msgType,
                eventType,
                status: body?.status || null,
                direction
              }), { expirationTtl: 3600 });
            }
        }

        await safeKvPut(env, '__lastWebhookTyping', JSON.stringify({
          at: new Date().toISOString(),
          direction,
          msgType,
          eventType,
          outboundLike,
          hasText: Boolean(text),
          textPath,
          bodyKeys: Object.keys(body || {}),
          typingRaw,
          typingState,
          typingDurationMs,
          candidateCount
        }), { expirationTtl: 3600 });

        return jsonResponse({ ok: true });
    } catch (err) {
        console.error('webhook error', err.message);
        return jsonResponse({ ok: false, error: err.message }, 500);
    }
}

async function handleDebugWebhook(env) {
  if (!hasMessageStore(env)) {
    return new Response(JSON.stringify({
      uiVersion: UI_VERSION,
      error: 'Missing message store binding: MESSAGES or CHAT_STATE'
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const orphan = await kvGet(env, '__orphanWebhook');
  const lastVisitorId = await kvGet(env, '__lastVisitorId');
  const lastVisitorConversationId = lastVisitorId ? await kvGet(env, `__convId:${lastVisitorId}`) : null;
  const lastMessages = lastVisitorId ? await kvGet(env, lastVisitorId) : null;
  const typing = lastVisitorId ? await getTypingState(env, lastVisitorId) : { isTyping: false, source: null };
  const lastWebhookTyping = await kvGet(env, '__lastWebhookTyping');
  const lastWebhookEvent = await kvGet(env, '__lastWebhookEvent');
  const lastOutboundWebhookEvent = await kvGet(env, '__lastOutboundWebhookEvent');
  const lastOutboundTextWebhook = await kvGet(env, '__lastOutboundTextWebhook');
  const lastAppendResult = await kvGet(env, '__lastAppendResult');
  const lastDisconnectEvent = await kvGet(env, '__lastDisconnectEvent');
  const lastCustomerTypingSend = await kvGet(env, '__lastCustomerTypingSend');
  const lastWebhookAuthFailure = await kvGet(env, '__lastWebhookAuthFailure');
  const lastFirstEventSeedAttempts = await kvGet(env, '__lastFirstEventSeedAttempts');
  const lastInitialEventSend = await kvGet(env, '__lastInitialEventSend');
  const lastParticipantDataSeed = await kvGet(env, '__lastParticipantDataSeed');
  const lastCustomerDisconnectSend = await kvGet(env, '__lastCustomerDisconnectSend');

  return new Response(JSON.stringify({
    uiVersion: UI_VERSION,
    lastVisitorId: lastVisitorId || null,
    lastVisitorConversationId: lastVisitorConversationId || null,
    hasLastMessages: Boolean(lastMessages),
    typing,
    lastWebhookTyping: lastWebhookTyping ? JSON.parse(lastWebhookTyping) : null,
    lastWebhookEvent: lastWebhookEvent ? JSON.parse(lastWebhookEvent) : null,
    lastOutboundWebhookEvent: lastOutboundWebhookEvent ? JSON.parse(lastOutboundWebhookEvent) : null,
    lastOutboundTextWebhook: lastOutboundTextWebhook ? JSON.parse(lastOutboundTextWebhook) : null,
    lastAppendResult: lastAppendResult ? JSON.parse(lastAppendResult) : null,
    lastDisconnectEvent: lastDisconnectEvent ? JSON.parse(lastDisconnectEvent) : null,
    lastCustomerTypingSend: lastCustomerTypingSend ? JSON.parse(lastCustomerTypingSend) : null,
    lastWebhookAuthFailure: lastWebhookAuthFailure ? JSON.parse(lastWebhookAuthFailure) : null,
    lastFirstEventSeedAttempts: lastFirstEventSeedAttempts ? JSON.parse(lastFirstEventSeedAttempts) : null,
    lastInitialEventSend: lastInitialEventSend ? JSON.parse(lastInitialEventSend) : null,
    lastParticipantDataSeed: lastParticipantDataSeed ? JSON.parse(lastParticipantDataSeed) : null,
    lastCustomerDisconnectSend: lastCustomerDisconnectSend ? JSON.parse(lastCustomerDisconnectSend) : null,
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
  if (!hasMessageStore(env)) return new Response('Missing message store binding: MESSAGES or CHAT_STATE', { status: 500 });

  const existing = await kvGet(env, visitorId);
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
  const hasDataActionSharedSecret = Boolean(env.DATA_ACTION_SHARED_SECRET);
  const hasMessagesKv = Boolean(env.MESSAGES);
  const hasChatState = Boolean(env.CHAT_STATE);
  const hasAnyMessageStore = hasMessagesKv || hasChatState;

  const ok = hasClientId && hasClientSecret && hasIntegrationId && hasAnyMessageStore;

  return new Response(JSON.stringify({
    ok,
    uiVersion: UI_VERSION,
    config: {
      genesysApiUrl: getGenesysApiUrl(env),
      hasClientId,
      hasClientSecret,
      hasIntegrationId,
      hasWebhookSecret,
      hasDataActionSharedSecret,
      hasMessagesKv,
      hasChatState,
      messageStore: hasChatState ? 'durable-object' : (hasMessagesKv ? 'kv' : 'none')
    }
  }), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' }
  });
}

export class ChatStateStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/get') {
      const key = url.searchParams.get('key');
      if (!key) return new Response('Missing key', { status: 400 });

      const record = await this.state.storage.get(key);
      if (!record) return new Response('', { status: 404 });

      if (record.expiresAt && Date.now() > record.expiresAt) {
        await this.state.storage.delete(key);
        return new Response('', { status: 404 });
      }

      return new Response(record.value || '', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/put') {
      const body = await request.json();
      const key = body && body.key ? String(body.key) : '';
      if (!key) return new Response('Missing key', { status: 400 });

      const value = body && body.value != null ? String(body.value) : '';
      const ttl = body && body.expirationTtl ? Number(body.expirationTtl) : 0;
      const expiresAt = Number.isFinite(ttl) && ttl > 0 ? Date.now() + (ttl * 1000) : null;

      await this.state.storage.put(key, { value, expiresAt });
      return new Response('OK', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/delete') {
      const body = await request.json();
      const key = body && body.key ? String(body.key) : '';
      if (!key) return new Response('Missing key', { status: 400 });

      await this.state.storage.delete(key);
      return new Response('OK', { status: 200 });
    }

    return new Response('Not Found', { status: 404 });
  }
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
  .chat-controls { display: flex; flex-direction: column; gap: 8px; align-items: center; }
  #sendBtn { width: 42px; height: 42px; border-radius: 50%; background: #1a73e8; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: background 0.2s; }
  #sendBtn:hover { background: #1558b0; }
  #sendBtn:disabled { background: #c5d9f7; cursor: default; }
  #sendBtn svg { width: 20px; height: 20px; fill: #fff; }
  #disconnectBtn { border: 1px solid #d7dbe7; background: #fff; color: #4a5568; border-radius: 16px; padding: 5px 10px; font-size: 11px; cursor: pointer; }
  #disconnectBtn:hover { background: #f6f8fc; }
  #disconnectBtn:disabled { opacity: 0.5; cursor: default; }

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
    <div class="chat-controls">
      <button id="sendBtn" onclick="send()" title="Send">
        <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
      </button>
      <button id="disconnectBtn" onclick="disconnectCustomer()" title="Disconnect chat">Disconnect</button>
    </div>
  </div>
  <div class="status-bar" id="statusBar">Connecting… (UI ${UI_VERSION})</div>
  <div class="debug-row">
    <div class="debug-pill" id="typingDebug"><span class="dot-mini off" id="typingDot"></span><span id="typingText">typing: off</span></div>
  </div>
</div>

<script>
  function getPersistentVisitorId() {
    try {
      const storageKey = 'openmsgVisitorId';
      const existing = localStorage.getItem(storageKey);
      if (existing && typeof existing === 'string' && existing.trim()) return existing.trim();
      const generated = 'visitor-' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(storageKey, generated);
      return generated;
    } catch {
      return 'visitor-' + Math.random().toString(36).slice(2, 12);
    }
  }

  const visitorId = getPersistentVisitorId();
  const visitorNickname = 'Web Customer';
  let seenCount = 0;
  let typingTimer = null;
  let connected = false;
  let localTypingSent = false;
  let hasSentCustomerMessage = false;
  let isDisconnected = false;

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
    if (isDisconnected) return;
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
        body: JSON.stringify({
          text,
          visitorId,
          visitorNickname,
          seedParticipantData: !hasSentCustomerMessage
        })
      });
      if (res.ok) {
        hasSentCustomerMessage = true;
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

  async function disconnectCustomer() {
    if (isDisconnected) return;

    const disconnectBtn = document.getElementById('disconnectBtn');
    const sendBtn = document.getElementById('sendBtn');
    const input = document.getElementById('msg');
    disconnectBtn.disabled = true;
    sendBtn.disabled = true;

    try {
      await sendTyping(false);
      const res = await fetch('/disconnect-customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId, visitorNickname })
      });

      if (res.ok) {
        isDisconnected = true;
        input.disabled = true;
        appendBubble('System', 'You disconnected the chat.', 'incoming');
        setStatus('Chat disconnected by customer');
        removeTyping();
        return;
      }

      const reason = await res.text();
      setStatus('Disconnect failed (' + res.status + '): ' + reason);
      disconnectBtn.disabled = false;
      sendBtn.disabled = false;
    } catch (e) {
      setStatus('Network error while disconnecting');
      disconnectBtn.disabled = false;
      sendBtn.disabled = false;
    }
  }

  async function sendTyping(isTyping) {
    if (isTyping === localTypingSent) return;
    localTypingSent = isTyping;
    try {
      await fetch('/send-typing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ visitorId, isTyping, visitorNickname })
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

  setInterval(pollReplies, 8000);
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
    if (method === 'POST' && pathname === '/disconnect-customer') return handleDisconnectCustomer(request, env);
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
