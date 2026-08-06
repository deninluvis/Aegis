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

export class SignalRoom {
  constructor(state) {
    this.state = state;
    this.sessions = [];
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected a websocket connection', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.handleSession(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  handleSession(ws) {
    ws.accept();

    if (this.sessions.length >= 2) {
      ws.send(JSON.stringify({ t: 'room-full' }));
      ws.close(1000, 'room full');
      return;
    }

    this.sessions.push(ws);

    if (this.sessions.length === 2) {
      this.sessions.forEach(s => s.send(JSON.stringify({ t: 'peer-joined' })));
    }

    ws.addEventListener('message', (evt) => {
      // Forward raw payload to the other peer in the room, untouched.
      this.sessions
        .filter(s => s !== ws && s.readyState === 1)
        .forEach(s => s.send(evt.data));
    });

    const leave = () => {
      this.sessions = this.sessions.filter(s => s !== ws);
      this.sessions.forEach(s => {
        try { s.send(JSON.stringify({ t: 'peer-left' })); } catch (e) {}
      });
    };
    ws.addEventListener('close', leave);
    ws.addEventListener('error', leave);
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
