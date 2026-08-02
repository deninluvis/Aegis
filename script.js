(() => {
  const $ = id => document.getElementById(id);
  let pc, dc, isHost;
  let myKeyPair, sharedAesKey;

  const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  // ---------- crypto helpers ----------
  async function genKeyPair() {
    return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  }
  async function exportPub(key) {
    const raw = await crypto.subtle.exportKey('jwk', key);
    return raw;
  }
  async function importPub(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  }
  async function deriveShared(privateKey, otherPublicKey) {
    return crypto.subtle.deriveKey(
      { name: 'ECDH', public: otherPublicKey },
      privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function fingerprintFrom(aesKey) {
    // Re-derive raw bits separately for display purposes via a hash of exported key material isn't possible
    // since the AES key is non-extractable by design. Instead we hash the combined public keys.
    return null; // replaced by combinedFingerprint below
  }
  async function combinedFingerprint(myPubJwk, theirPubJwk) {
    const a = JSON.stringify(myPubJwk.x) + JSON.stringify(myPubJwk.y);
    const b = JSON.stringify(theirPubJwk.x) + JSON.stringify(theirPubJwk.y);
    const combined = [a, b].sort().join('|'); // order-independent so both sides match
    const enc = new TextEncoder().encode(combined);
    const hash = await crypto.subtle.digest('SHA-256', enc);
    return new Uint8Array(hash);
  }
  function renderFingerprint(bytes) {
    const grid = $('fingerprint');
    grid.innerHTML = '';
    for (let i = 0; i < 40; i++) {
      const byte = bytes[i % bytes.length];
      const bit = (byte >> (i % 8)) & 1;
      const cell = document.createElement('div');
      cell.className = 'fp-cell' + (bit ? ' on' : '');
      grid.appendChild(cell);
    }
    const words = Array.from(bytes.slice(0, 6)).map(b => b.toString(16).padStart(2, '0')).join(' ');
    $('fpWords').textContent = 'Short code: ' + words;
  }

  async function encryptBytes(bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedAesKey, bytes);
    const payload = new Uint8Array(iv.length + ct.byteLength);
    payload.set(iv, 0);
    payload.set(new Uint8Array(ct), iv.length);
    let bin = '';
    for (let i = 0; i < payload.length; i++) bin += String.fromCharCode(payload[i]);
    return btoa(bin);
  }
  async function decryptBytes(b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, sharedAesKey, ct);
    return new Uint8Array(pt);
  }
  async function encryptObj(obj) {
    return encryptBytes(new TextEncoder().encode(JSON.stringify(obj)));
  }
  async function decryptObj(b64) {
    const bytes = await decryptBytes(b64);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  function bytesToB64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64ToBytes(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ---------- UI helpers ----------
  function markDone(stepEl) { stepEl.classList.remove('active'); stepEl.classList.add('done'); stepEl.style.display = 'none'; }
  function markActive(stepEl) { stepEl.style.display = 'block'; stepEl.classList.add('active'); }
  function setStatus(id, text, cls) {
    const el = $(id);
    el.innerHTML = `<span class="dot ${cls||''}"></span>${text}`;
  }
  const HISTORY_KEY = 'cipherline_history';

  function loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveHistoryEntry(text, cls) {
    if (cls === 'sys') return; // don't persist system notices
    const hist = loadHistory();
    hist.push({ text, cls, ts: Date.now() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
    updateHistoryBar();
  }
  function updateHistoryBar() {
    const hist = loadHistory();
    const bar = $('historyBar');
    if (hist.length === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    $('historyCount').textContent = hist.length + ' message' + (hist.length === 1 ? '' : 's') + ' saved on this device';
  }
  function renderSavedHistory() {
    const hist = loadHistory();
    if (hist.length === 0) return;
    const log = $('chatLog');
    hist.forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg ' + m.cls;
      div.textContent = m.text;
      log.appendChild(div);
    });
    const divider = document.createElement('div');
    divider.className = 'msg sys';
    divider.textContent = '— saved history above · new session below —';
    log.appendChild(divider);
  }
  $('btnClearHistory').addEventListener('click', () => {
    localStorage.removeItem(HISTORY_KEY);
    updateHistoryBar();
    const log = $('chatLog');
    const kept = Array.from(log.children).filter(el => el.textContent.startsWith('Line connected') || el.textContent.startsWith('Line closed'));
    log.innerHTML = '';
    kept.forEach(el => log.appendChild(el));
  });
  renderSavedHistory();
  updateHistoryBar();

  function addMsg(text, cls, persist = true) {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (persist) saveHistoryEntry(text, cls);
  }

  function waitIceComplete(pc) {
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      function check() {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      }
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  const incoming = {}; // id -> { name, size, mime, chunks: [], received: 0 }

  function addFileBubble(name, size, url, cls, persistNote = true) {
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.innerHTML = `<div class="file-bubble"><span class="fname">📎 ${name}</span><span class="fmeta">${fmtSize(size)}</span><a href="${url}" download="${name}">Download</a></div>`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (persistNote) saveHistoryEntry('📎 ' + (cls === 'me' ? 'sent' : 'received') + ': ' + name + ' (' + fmtSize(size) + ')', 'sys-file');
  }

  function setupDataChannelHandlers() {
    dc.bufferedAmountLowThreshold = 262144; // 256KB
    dc.onopen = () => {
      $('chat').classList.add('active');
      $('msgInput').disabled = false;
      $('btnSend').disabled = false;
      $('btnAttach').disabled = false;
      document.body.classList.add('connected');
      ['step1', 'step2host', 'step3host', 'step2join', 'step3join'].forEach(id => {
        $(id).style.display = 'none';
      });
      addMsg('Line connected. Messages below are end-to-end encrypted.', 'sys');
      if (isHost) setStatus('connectStatusHost', 'connected', 'ok');
      else setStatus('connectStatusJoin', 'connected', 'ok');
    };
    dc.onclose = () => addMsg('Line closed.', 'sys');
    dc.onmessage = async (e) => {
      try {
        const obj = await decryptObj(e.data);
        if (obj.t === 'text') {
          addMsg(obj.v, 'them');
        } else if (obj.t === 'file-start') {
          incoming[obj.id] = { name: obj.name, size: obj.size, mime: obj.mime, chunks: new Array(obj.chunks), received: 0 };
          addMsg('Receiving file: ' + obj.name + ' (' + fmtSize(obj.size) + ')…', 'sys');
        } else if (obj.t === 'file-chunk') {
          const f = incoming[obj.id];
          if (!f) return;
          f.chunks[obj.i] = b64ToBytes(obj.d);
          f.received++;
        } else if (obj.t === 'file-end') {
          const f = incoming[obj.id];
          if (!f) return;
          const blob = new Blob(f.chunks, { type: f.mime || 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          addFileBubble(f.name, f.size, url, 'them');
          delete incoming[obj.id];
        }
      } catch (err) {
        addMsg('[could not decrypt a message — keys may not match]', 'sys');
      }
    };
  }

  function waitForBufferLow(channel) {
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise(resolve => {
      function handler() {
        channel.removeEventListener('bufferedamountlow', handler);
        resolve();
      }
      channel.addEventListener('bufferedamountlow', handler);
    });
  }

  const CHUNK_SIZE = 12000; // raw bytes per chunk

  async function sendFile(file) {
    if (!dc || dc.readyState !== 'open') return;
    const id = Math.random().toString(36).slice(2);
    const buf = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.ceil(buf.length / CHUNK_SIZE) || 1;

    dc.send(await encryptObj({ t: 'file-start', id, name: file.name, size: file.size, mime: file.type, chunks: totalChunks }));

    for (let i = 0; i < totalChunks; i++) {
      const chunk = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const payload = await encryptObj({ t: 'file-chunk', id, i, d: bytesToB64(chunk) });
      await waitForBufferLow(dc);
      dc.send(payload);
    }
    dc.send(await encryptObj({ t: 'file-end', id }));

    const url = URL.createObjectURL(file);
    addFileBubble(file.name, file.size, url, 'me');
  }

  $('btnAttach').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) sendFile(file);
    e.target.value = '';
  });

  let firstMessageSent = false;

  async function sendMessage() {
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text || !dc || dc.readyState !== 'open') return;
    const payload = await encryptObj({ t: 'text', v: text });
    dc.send(payload);
    addMsg(text, 'me');
    input.value = '';
    if (!firstMessageSent) {
      firstMessageSent = true;
      $('step4').style.display = 'none';
    }
  }
  $('btnSend').addEventListener('click', sendMessage);
  $('msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

  // ---------- role selection ----------
  $('btnHost').addEventListener('click', () => {
    isHost = true;
    $('btnHost').disabled = true;
    $('btnJoin').disabled = true;
    markActive($('step2host'));
  });
  $('btnJoin').addEventListener('click', () => {
    isHost = false;
    $('btnHost').disabled = true;
    $('btnJoin').disabled = true;
    markActive($('step2join'));
  });

  // ---------- HOST flow ----------
  $('btnCreateOffer').addEventListener('click', async () => {
    $('btnCreateOffer').disabled = true;
    setStatus('offerStatus', 'generating…');
    myKeyPair = await genKeyPair();
    pc = new RTCPeerConnection(STUN);
    dc = pc.createDataChannel('cipher-line');
    setupDataChannelHandlers();

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);

    const pubJwk = await exportPub(myKeyPair.publicKey);
    const bundle = { sdp: pc.localDescription, pub: pubJwk };
    $('offerOut').value = btoa(JSON.stringify(bundle));
    $('copyOffer').disabled = false;
    setStatus('offerStatus', 'ready to send', 'ok');
    markActive($('step3host'));
  });
  $('copyOffer').addEventListener('click', () => {
    navigator.clipboard.writeText($('offerOut').value);
    $('copyOffer').textContent = 'Copied';
    setTimeout(() => $('copyOffer').textContent = 'Copy invite', 1500);
  });

  $('btnAcceptAnswer').addEventListener('click', async () => {
    try {
      const raw = $('answerIn').value.trim();
      const bundle = JSON.parse(atob(raw));
      await pc.setRemoteDescription(bundle.sdp);
      const theirPub = await importPub(bundle.pub);
      sharedAesKey = await deriveShared(myKeyPair.privateKey, theirPub);
      const myPubJwk = await exportPub(myKeyPair.publicKey);
      const fp = await combinedFingerprint(myPubJwk, bundle.pub);
      renderFingerprint(fp);
      markDone($('step3host'));
      markActive($('step4'));
      setStatus('connectStatusHost', 'connecting…');
    } catch (err) {
      setStatus('connectStatusHost', 'that reply didn\'t parse — check it was copied in full', 'err');
    }
  });

  // ---------- JOIN flow ----------
  $('btnCreateAnswer').addEventListener('click', async () => {
    try {
      const raw = $('offerIn').value.trim();
      const bundle = JSON.parse(atob(raw));
      myKeyPair = await genKeyPair();
      pc = new RTCPeerConnection(STUN);
      pc.ondatachannel = (e) => {
        dc = e.channel;
        setupDataChannelHandlers();
      };
      await pc.setRemoteDescription(bundle.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await waitIceComplete(pc);

      const theirPub = await importPub(bundle.pub);
      sharedAesKey = await deriveShared(myKeyPair.privateKey, theirPub);
      const myPubJwk = await exportPub(myKeyPair.publicKey);
      const fp = await combinedFingerprint(myPubJwk, bundle.pub);
      renderFingerprint(fp);

      const outBundle = { sdp: pc.localDescription, pub: myPubJwk };
      $('answerOut').value = btoa(JSON.stringify(outBundle));
      $('copyAnswer').disabled = false;

      markActive($('step3join'));
      markActive($('step4'));
    } catch (err) {
      alert('That invite didn\'t parse — check it was copied in full.');
    }
  });
  $('copyAnswer').addEventListener('click', () => {
    navigator.clipboard.writeText($('answerOut').value);
    $('copyAnswer').textContent = 'Copied';
    setTimeout(() => $('copyAnswer').textContent = 'Copy reply', 1500);
  });
})();