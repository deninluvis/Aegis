# Aegis

A direct line between two browsers. No account, no server relaying your messages, no third party holding a key.

Aegis is a static, client-side web app for peer-to-peer encrypted chat, file transfer, and voice calls over WebRTC. Connection details and encryption keys are exchanged directly between the two people talking — you copy them to the other person yourself, or use an optional short-code relay that only forwards the connection handshake, never your messages.

Live at [aegis.deninluvis.com](https://aegis.deninluvis.com).

## How it works

1. **Start or join a line.** One person starts a line, the other joins it.
2. **Exchange connection info.** This can be done two ways:
   - **Copy-paste:** the host generates an invite blob (WebRTC offer + ECDH public key) and sends it to the other person by any channel (text, email, whatever). They paste it back a reply blob, and the host pastes that in to connect.
   - **Short code (relay):** an optional Cloudflare Worker relay forwards the same handshake automatically using a short code instead of copy-paste, and lets a saved contact reconnect later.
3. **Verify.** Once connected, both sides see a fingerprint grid generated from the shared key. If it matches on both screens, no one is in the middle.
4. **Chat.** Messages, files, and voice calls all flow directly between the two browsers over the encrypted WebRTC data/media channels.

Encryption uses ECDH for key agreement and AES-256-GCM for message encryption. Keys are generated fresh in the browser and never leave it — only public keys travel in the invite/reply text. The app uses public STUN servers only to help two devices find each other; no message, key, file, or call data passes through them.

The optional relay briefly sees each connection setup (not message content), which is why the fingerprint check matters even in short-code mode.

## Project structure

```
index.html        App shell and UI
css/style.css      Styles
js/script.js       WebRTC signaling, crypto, chat/file/call logic
worker/            Optional Cloudflare Worker signaling relay for short-code connect
  worker.js         Durable Object that forwards handshake messages between two peers in a room
  wrangler.toml     Worker configuration
CNAME              GitHub Pages custom domain
```

## Running locally

The app itself is static — serve the repo root with any static file server and open `index.html`:

```
python3 -m http.server 8080
```

### Running the relay worker (optional)

The short-code connect feature requires the signaling relay, deployed with [Wrangler](https://developers.cloudflare.com/workers/wrangler/):

```
cd worker
wrangler dev
```

Deploy with `wrangler deploy` from the `worker/` directory.
