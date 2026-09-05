// Aegis signaling relay.
//
// This Worker's ONLY job is to forward the connection-setup handshake
// (WebRTC SDP + ECDH public key, already base64-wrapped by the client)
// between exactly two browsers that share the same room code. It never
// sees a message, a file, a call, or the shared encryption key — those
// only ever exist directly between the two peers once WebRTC connects.
//
// Each room lives in its own Durable Object instance so state (who's
// connected) is isolated per room and doesn't need a database.
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
export class SignalRoom {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
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
