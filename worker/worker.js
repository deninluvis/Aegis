// Aegis signaling relay.
//
// This Worker's main job is to forward the connection-setup handshake (WebRTC SDP +
// ECDH public key, already base64-wrapped by the client) between exactly two browsers
// that share the same room code. It never sees a message, a file, a call, or the
// shared encryption key — those only ever exist directly between the two peers once
// WebRTC connects.
//
// It also relays a wake-up push notification when one side sends a message while the
// other isn't reachable directly. That ping carries only a sender name/avatar and the
// room code — never message content, which this Worker never receives in the first
// place. See handleNotify() below.
//
// Each room lives in its own Durable Object instance so state (who's connected, and
// each side's push subscription) is isolated per room and doesn't need a database.
//
// Uses the WebSocket Hibernation API (state.acceptWebSocket / the
// webSocketMessage/webSocketClose/webSocketError handlers below) instead
// of the plain ws.accept() + addEventListener pattern. A DO using the
// plain pattern has to stay fully resident in memory for the life of the
// connection; if the runtime suspends it between events (which it can,
// since a room can sit open for a while waiting for the second peer),
// re-waking it to process a close can lag long enough that the browser
// gives up and reports an abnormal closure. Hibernatable sockets are
// tracked by the runtime itself, so the DO can go idle between messages
// without the connection dropping.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export class SignalRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    // register-push/notify are plain JSON POSTs from the app's own origin, which is a
    // different origin than this Worker — the browser sends a CORS preflight (OPTIONS)
    // before the real request, and without these headers it blocks the request entirely
    // before it ever reaches handleRegisterPush/handleNotify.
    if (url.pathname === '/register-push' || url.pathname === '/notify') {
      if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
      const resp = url.pathname === '/register-push'
        ? await this.handleRegisterPush(request)
        : await this.handleNotify(request, url);
      const withCors = new Response(resp.body, resp);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => withCors.headers.set(k, v));
      return withCors;
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket connection', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const existing = this.state.getWebSockets();
    if (existing.length >= 2) {
      // Reject the third peer, but still let it see why — accept it plainly
      // (not hibernatable, it's about to close anyway) just long enough to
      // deliver the message.
      server.accept();
      server.send(JSON.stringify({ t: 'room-full' }));
      server.close(1000, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    this.state.acceptWebSocket(server);

    const sessions = this.state.getWebSockets();
    if (sessions.length === 2) {
      sessions.forEach(s => { try { s.send(JSON.stringify({ t: 'peer-joined' })); } catch (e) {} });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    // Forward raw payload to the other peer in the room, untouched.
    this.state.getWebSockets()
      .filter(s => s !== ws)
      .forEach(s => { try { s.send(message); } catch (e) {} });
  }

  async webSocketClose(ws, code, reason, wasClean) {
    try { ws.close(code, reason); } catch (e) {}
    this.notifyPeerLeft(ws);
  }

  async webSocketError(ws) {
    this.notifyPeerLeft(ws);
  }

  notifyPeerLeft(ws) {
    this.state.getWebSockets()
      .filter(s => s !== ws)
      .forEach(s => { try { s.send(JSON.stringify({ t: 'peer-left' })); } catch (e) {} });
  }

  // A device registers (or re-registers) its push subscription for its role in this
  // room. Stored in this Durable Object's own storage, keyed by role — no separate
  // database, and nothing here ever records who the two people are.
  async handleRegisterPush(request) {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    let body;
    try { body = await request.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
    const { role, subscription } = body || {};
    if (role !== 'host' && role !== 'join') return new Response('bad role', { status: 400 });
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return new Response('bad subscription', { status: 400 });
    }
    await this.state.storage.put('sub:' + role, subscription);
    return new Response('ok');
  }

  // Sent when one side queues a message because the other isn't reachable over the
  // WebRTC data channel right now. Carries only a display name/avatar (chosen by the
  // sender, not verified) and the room code — never message content, which this
  // Worker never sees regardless.
  async handleNotify(request, url) {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const room = url.searchParams.get('room');
    let body;
    try { body = await request.json(); } catch (e) { return new Response('bad json', { status: 400 }); }
    const { role, name, avatar } = body || {};
    if (role !== 'host' && role !== 'join') return new Response('bad role', { status: 400 });

    const peerRole = role === 'host' ? 'join' : 'host';
    const sub = await this.state.storage.get('sub:' + peerRole);
    if (!sub) return new Response('no subscription for peer', { status: 404 });

    const title = (avatar ? avatar + ' ' : '') + (name || 'Someone');
    try {
      await sendWebPush(sub, { title, body: 'Sent you a message', tag: 'aegis-push-' + room, roomCode: room }, this.env);
    } catch (err) {
      if (err.status === 404 || err.status === 410) {
        // The push service says this subscription is gone for good — stop trying it.
        await this.state.storage.delete('sub:' + peerRole);
      }
      return new Response('push send failed: ' + err.message, { status: 502 });
    }
    return new Response('ok');
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get('room');

    if (!room || !/^[A-Za-z0-9]{4,32}$/.test(room)) {
      return new Response('missing or invalid room code', { status: 400 });
    }

    const id = env.SIGNAL_ROOM.idFromName(room);
    const stub = env.SIGNAL_ROOM.get(id);
    return stub.fetch(request);
  }
};

// ---------- Web Push (RFC 8291 payload encryption + RFC 8292 VAPID auth) ----------
// Implemented directly against the Workers runtime's native Web Crypto API rather
// than a library, since the usual Node "web-push" package makes its HTTP request
// through Node's http/https modules, which isn't how Workers talk to the network.

const VAPID_PUBLIC_KEY = 'BEx22de41LmQa0w6ZnUuGeNc2v1Utt7XGVn6JxPt_zsQNVzynCzOwoV_JzL7zHfzEl4I2U4HnngziRxwnvmc6jc';

function base64UrlToBytes(base64Url) {
  const padding = '='.repeat((4 - base64Url.length % 4) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
function bytesToBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function concatBytes(arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function hkdf(ikmBytes, saltBytes, infoBytes, lengthBytes) {
  const key = await crypto.subtle.importKey('raw', ikmBytes, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: saltBytes, info: infoBytes },
    key,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

async function signVapidJwt(audience, privateKeyB64Url) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'https://aegis.deninluvis.com' };
  const enc = (obj) => bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = enc(header) + '.' + enc(claims);

  const pubRaw = base64UrlToBytes(VAPID_PUBLIC_KEY); // 65 bytes: 0x04 || x(32) || y(32)
  const jwk = {
    kty: 'EC', crv: 'P-256',
    x: bytesToBase64Url(pubRaw.slice(1, 33)),
    y: bytesToBase64Url(pubRaw.slice(33, 65)),
    d: privateKeyB64Url,
    ext: true,
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput));
  return signingInput + '.' + bytesToBase64Url(new Uint8Array(sigBuf));
}

async function encryptWebPushPayload(subscription, payloadObj) {
  const uaPublicRaw = base64UrlToBytes(subscription.keys.p256dh);
  const authSecret = base64UrlToBytes(subscription.keys.auth);

  const uaPublicKey = await crypto.subtle.importKey('raw', uaPublicRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const asKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', asKeyPair.publicKey));

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaPublicKey }, asKeyPair.privateKey, 256)
  );

  const keyInfo = concatBytes([new TextEncoder().encode('WebPush: info\0'), uaPublicRaw, asPublicRaw]);
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  const plaintext = concatBytes([new TextEncoder().encode(JSON.stringify(payloadObj)), new Uint8Array([0x02])]);
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, plaintext)
  );

  const rsBytes = new Uint8Array(4);
  new DataView(rsBytes.buffer).setUint32(0, 4096, false);
  const header = concatBytes([salt, rsBytes, new Uint8Array([asPublicRaw.length]), asPublicRaw]);
  return concatBytes([header, ciphertext]);
}

async function sendWebPush(subscription, payloadObj, env) {
  const body = await encryptWebPushPayload(subscription, payloadObj);
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await signVapidJwt(audience, env.VAPID_PRIVATE_KEY);

  const resp = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
      'Authorization': 'vapid t=' + jwt + ', k=' + VAPID_PUBLIC_KEY,
    },
    body,
  });
  if (!resp.ok) {
    const err = new Error('push endpoint returned ' + resp.status);
    err.status = resp.status;
    throw err;
  }
}
