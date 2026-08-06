(() => {
  const $ = id => document.getElementById(id);

  // connections: contactId -> { pc, dc, myKeyPair, sharedAesKey, peerPubJwk, contact, status, showFingerprint, attachHandlers }
  const connections = {};
  let currentView = null; // { type: 'contact', contactId } | { type: 'group', groupId }
  let pendingLineName = null;
  let pendingReconnectContactId = null;

  const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  // ---------- PWA install support ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // ---------- crypto helpers ----------
  async function genKeyPair() {
    return crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  }
  async function exportPub(key) {
    return crypto.subtle.exportKey('jwk', key);
  }
  async function importPub(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  }
  async function importPriv(jwk) {
    return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
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

  async function encryptBytes(key, bytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    const payload = new Uint8Array(iv.length + ct.byteLength);
    payload.set(iv, 0);
    payload.set(new Uint8Array(ct), iv.length);
    let bin = '';
    for (let i = 0; i < payload.length; i++) bin += String.fromCharCode(payload[i]);
    return btoa(bin);
  }
  async function decryptBytes(key, b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const iv = bytes.slice(0, 12);
    const ct = bytes.slice(12);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return new Uint8Array(pt);
  }
  async function encryptObj(key, obj) {
    return encryptBytes(key, new TextEncoder().encode(JSON.stringify(obj)));
  }
  async function decryptObj(key, b64) {
    const bytes = await decryptBytes(key, b64);
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

  // ---------- contacts (named 1:1 lines) ----------
  const CONTACTS_KEY = 'aegis_contacts';
  function getContacts() {
    try { return JSON.parse(localStorage.getItem(CONTACTS_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveContacts(list) { localStorage.setItem(CONTACTS_KEY, JSON.stringify(list)); }

  // ---------- groups ----------
  const GROUPS_KEY = 'aegis_groups';
  function getGroups() {
    try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); } catch (e) { return []; }
  }
  function saveGroups(list) { localStorage.setItem(GROUPS_KEY, JSON.stringify(list)); }
  function relayCapableContacts() {
    return getContacts().filter(c => c.roomCode && c.myPub && c.myPriv);
  }

  function renderHomeLists() {
    const contacts = getContacts();
    const listEl = $('contactsList');
    listEl.innerHTML = '';
    if (contacts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'contacts-empty';
      empty.textContent = 'No lines yet — start one below.';
      listEl.appendChild(empty);
    } else {
      contacts.forEach(c => {
        const row = document.createElement('button');
        row.className = 'contact-row';
        const dot = document.createElement('span'); dot.className = 'dot';
        const name = document.createElement('span'); name.className = 'contact-name'; name.textContent = c.name;
        const meta = document.createElement('span'); meta.className = 'contact-meta'; meta.textContent = c.roomCode ? 'tap to reconnect' : 'manual only';
        row.appendChild(dot); row.appendChild(name); row.appendChild(meta);
        row.addEventListener('click', () => openContact(c.id));
        listEl.appendChild(row);
      });
    }

    const groups = getGroups();
    const groupsListEl = $('groupsList');
    groupsListEl.innerHTML = '';
    $('groupsLabel').style.display = groups.length ? 'block' : 'none';
    groups.forEach(g => {
      const row = document.createElement('button');
      row.className = 'contact-row group-row';
      const dot = document.createElement('span'); dot.className = 'dot';
      const name = document.createElement('span'); name.className = 'contact-name'; name.textContent = g.name;
      const meta = document.createElement('span'); meta.className = 'contact-meta'; meta.textContent = g.memberIds.length + ' members';
      row.appendChild(dot); row.appendChild(name); row.appendChild(meta);
      row.addEventListener('click', () => openGroup(g.id));
      groupsListEl.appendChild(row);
    });
  }

  // ---------- per-conversation local history ----------
  function historyKey(id) { return 'aegis_history_' + id; }
  function groupHistoryKey(id) { return 'aegis_group_history_' + id; }
  function loadHistory(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveHistoryEntry(key, entry) {
    if (!key || entry.cls === 'sys') return; // don't persist system notices
    const hist = loadHistory(key);
    hist.push(Object.assign({}, entry, { ts: Date.now() }));
    localStorage.setItem(key, JSON.stringify(hist));
    updateHistoryBar(key);
  }
  function updateHistoryBar(key) {
    const hist = loadHistory(key);
    const bar = $('historyBar');
    if (hist.length === 0) { bar.style.display = 'none'; return; }
    bar.style.display = 'flex';
    $('historyCount').textContent = hist.length + ' message' + (hist.length === 1 ? '' : 's') + ' saved on this device';
  }
  function renderSavedHistory(key) {
    const hist = loadHistory(key);
    if (hist.length === 0) return;
    const log = $('chatLog');
    hist.forEach(m => {
      const div = document.createElement('div');
      div.className = 'msg ' + m.cls;
      if (m.senderName) {
        const tag = document.createElement('div');
        tag.className = 'msg-sender';
        tag.textContent = m.senderName;
        div.appendChild(tag);
      }
      const body = document.createElement('div');
      body.textContent = m.text;
      div.appendChild(body);
      log.appendChild(div);
    });
    const divider = document.createElement('div');
    divider.className = 'msg sys';
    divider.textContent = '— saved history above · new session below —';
    log.appendChild(divider);
  }
  function currentHistoryKey() {
    if (!currentView) return null;
    return currentView.type === 'group' ? groupHistoryKey(currentView.groupId) : historyKey(currentView.contactId);
  }
  $('btnClearHistory').addEventListener('click', () => {
    const key = currentHistoryKey();
    if (!key) return;
    localStorage.removeItem(key);
    updateHistoryBar(key);
    const log = $('chatLog');
    const kept = Array.from(log.children).filter(el => el.textContent.startsWith('Line connected') || el.textContent.startsWith('Line closed'));
    log.innerHTML = '';
    kept.forEach(el => log.appendChild(el));
  });

  function addMsg(text, cls, opts) {
    opts = opts || {};
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    if (opts.senderName) {
      const tag = document.createElement('div');
      tag.className = 'msg-sender';
      tag.textContent = opts.senderName;
      div.appendChild(tag);
    }
    const body = document.createElement('div');
    body.textContent = text;
    div.appendChild(body);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (opts.persist !== false) {
      const key = currentHistoryKey();
      saveHistoryEntry(key, { text: text, cls: cls, senderName: opts.senderName || null });
    }
  }

  function waitIceComplete(pc, timeoutMs) {
    timeoutMs = timeoutMs || 2500;
    return new Promise(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve();
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
      }
      function check() {
        if (pc.iceGatheringState === 'complete') finish();
      }
      pc.addEventListener('icegatheringstatechange', check);
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  const incoming = {}; // file transfer id -> { name, size, mime, chunks: [], received: 0 } (1:1 only)

  function addFileBubble(name, size, url, cls, persistNote) {
    if (persistNote === undefined) persistNote = true;
    const log = $('chatLog');
    const div = document.createElement('div');
    div.className = 'msg ' + cls;
    div.innerHTML = '<div class="file-bubble"><span class="fname">\ud83d\udcce ' + name + '</span><span class="fmeta">' + fmtSize(size) + '</span><a href="' + url + '" download="' + name + '">Download</a></div>';
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (persistNote) {
      const key = currentHistoryKey();
      saveHistoryEntry(key, { text: '\ud83d\udcce ' + (cls === 'me' ? 'sent' : 'received') + ': ' + name + ' (' + fmtSize(size) + ')', cls: 'sys-file' });
    }
  }

  function setupPeerConnectionMediaHandlers(peerConn) {
    peerConn.ontrack = (e) => {
      $('remoteAudio').srcObject = e.streams[0];
    };
  }

  // ---------- keep the connection alive on mobile ----------
  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) {}
  }
  function releaseWakeLockIfIdle() {
    const anyOpen = Object.keys(connections).some(k => connections[k].status === 'open');
    if (!anyOpen && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !wakeLock && Object.keys(connections).some(k => connections[k].status === 'open')) {
      requestWakeLock();
    }
  });

  // ---------- shared negotiation logic (per connection object) ----------
  async function genConnOfferBundle(conn) {
    if (!conn.myKeyPair) conn.myKeyPair = await genKeyPair();
    conn.pc = new RTCPeerConnection(STUN);
    conn.dc = conn.pc.createDataChannel('cipher-line');
    setupPeerConnectionMediaHandlers(conn.pc);
    conn.attachHandlers();

    const offer = await conn.pc.createOffer();
    await conn.pc.setLocalDescription(offer);
    await waitIceComplete(conn.pc);

    const pubJwk = await exportPub(conn.myKeyPair.publicKey);
    return btoa(JSON.stringify({ sdp: conn.pc.localDescription, pub: pubJwk }));
  }

  async function acceptConnAnswerBundle(conn, raw) {
    const bundle = JSON.parse(atob(raw));
    await conn.pc.setRemoteDescription(bundle.sdp);
    const theirPub = await importPub(bundle.pub);
    conn.sharedAesKey = await deriveShared(conn.myKeyPair.privateKey, theirPub);
    conn.peerPubJwk = bundle.pub;
    if (conn.showFingerprint) {
      const myPubJwk = await exportPub(conn.myKeyPair.publicKey);
      renderFingerprint(await combinedFingerprint(myPubJwk, bundle.pub));
    }
    return bundle;
  }

  async function genConnAnswerBundle(conn, raw) {
    const bundle = JSON.parse(atob(raw));
    if (!conn.myKeyPair) conn.myKeyPair = await genKeyPair();
    conn.pc = new RTCPeerConnection(STUN);
    setupPeerConnectionMediaHandlers(conn.pc);
    conn.pc.ondatachannel = (e) => {
      conn.dc = e.channel;
      conn.attachHandlers();
    };
    await conn.pc.setRemoteDescription(bundle.sdp);
    const answer = await conn.pc.createAnswer();
    await conn.pc.setLocalDescription(answer);
    await waitIceComplete(conn.pc);

    const theirPub = await importPub(bundle.pub);
    conn.sharedAesKey = await deriveShared(conn.myKeyPair.privateKey, theirPub);
    conn.peerPubJwk = bundle.pub;
    if (conn.showFingerprint) {
      const myPubJwk = await exportPub(conn.myKeyPair.publicKey);
      renderFingerprint(await combinedFingerprint(myPubJwk, bundle.pub));
    }

    const myPubJwk2 = await exportPub(conn.myKeyPair.publicKey);
    return btoa(JSON.stringify({ sdp: conn.pc.localDescription, pub: myPubJwk2 }));
  }

  // ---------- 1:1 data channel handlers (new line + reconnect) ----------
  async function finalizeContactOnConnect(conn) {
    const contacts = getContacts();
    if (currentView && currentView.type === 'contact' && conn.contact && conn.contact.id) {
      const c = contacts.find(x => x.id === conn.contact.id);
      if (c && conn.peerPubJwk) { c.peerPub = conn.peerPubJwk; saveContacts(contacts); }
      connections[c ? c.id : conn.contact.id] = conn;
      renderConversationUI(c || conn.contact);
      return;
    }
    const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const contact = { id: id, name: pendingLineName || 'Unnamed', isHost: conn.isHost, roomCode: conn.usingRelay ? conn.roomCode : null, peerPub: conn.peerPubJwk, myPub: null, myPriv: null };
    if (conn.myKeyPair) {
      try {
        contact.myPub = await exportPub(conn.myKeyPair.publicKey);
        contact.myPriv = await crypto.subtle.exportKey('jwk', conn.myKeyPair.privateKey);
      } catch (e) {}
    }
    contacts.push(contact);
    saveContacts(contacts);
    conn.contact = contact;
    currentView = { type: 'contact', contactId: id };
    connections[id] = conn;
    renderConversationUI(contact);
  }

  function renderConversationUI(contactOrGroup) {
    $('chatHeaderName').textContent = contactOrGroup.name;
    const log = $('chatLog');
    log.innerHTML = '';
    renderSavedHistory(currentHistoryKey());
    updateHistoryBar(currentHistoryKey());
  }

  function setupDataChannelHandlersForContact(conn) {
    conn.dc.bufferedAmountLowThreshold = 262144;
    conn.dc.onopen = async () => {
      conn.status = 'open';
      $('chat').classList.add('active');
      $('msgInput').disabled = false;
      $('btnSend').disabled = false;
      $('btnAttach').disabled = false;
      $('btnCallAudio').disabled = false;
      document.body.classList.add('connected');
      ['step1', 'step2host', 'step3host', 'step2join', 'step3join', 'step2hostRelay', 'step2joinRelay', 'reconnectPanel', 'contactsPanel', 'newGroupPanel'].forEach(id => {
        $(id).style.display = 'none';
      });
      $('chatHeader').style.display = 'flex';
      $('groupChatHeader').style.display = 'none';

      await finalizeContactOnConnect(conn);

      addMsg('Line connected. Messages below are end-to-end encrypted.', 'sys');
      if (conn.isHost) setStatus('connectStatusHost', 'connected', 'ok');
      else setStatus('connectStatusJoin', 'connected', 'ok');
      requestWakeLock();
    };
    conn.dc.onclose = () => {
      conn.status = 'closed';
      if (inCall || pendingCallOffer) endCallUI();
      releaseWakeLockIfIdle();
      addMsg('Line closed.', 'sys');
    };
    conn.dc.onmessage = async (e) => {
      try {
        const obj = await decryptObj(conn.sharedAesKey, e.data);
        await handleContactMessage(conn, obj);
      } catch (err) {
        addMsg('[could not decrypt a message — keys may not match]', 'sys');
      }
    };
  }

  async function handleContactMessage(conn, obj) {
    if (obj.t === 'text') {
      addMsg(obj.v, 'them');
    } else if (obj.t === 'file-start') {
      incoming[obj.id] = { name: obj.name, size: obj.size, mime: obj.mime, chunks: new Array(obj.chunks), received: 0 };
      addMsg('Receiving file: ' + obj.name + ' (' + fmtSize(obj.size) + ')\u2026', 'sys');
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
    } else if (obj.t === 'call-offer') {
      handleIncomingCallOffer(conn, obj);
    } else if (obj.t === 'call-answer') {
      await handleCallAnswer(conn, obj);
    } else if (obj.t === 'call-decline') {
      endCallUI('Call declined.');
    } else if (obj.t === 'call-end') {
      endCallUI('Call ended.');
    }
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

  const CHUNK_SIZE = 12000;

  async function sendFile(file) {
    if (!currentView || currentView.type !== 'contact') return;
    const conn = connections[currentView.contactId];
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') return;
    const id = Math.random().toString(36).slice(2);
    const buf = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.ceil(buf.length / CHUNK_SIZE) || 1;

    conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'file-start', id: id, name: file.name, size: file.size, mime: file.type, chunks: totalChunks }));

    for (let i = 0; i < totalChunks; i++) {
      const chunk = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const payload = await encryptObj(conn.sharedAesKey, { t: 'file-chunk', id: id, i: i, d: bytesToB64(chunk) });
      await waitForBufferLow(conn.dc);
      conn.dc.send(payload);
    }
    conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'file-end', id: id }));

    const url = URL.createObjectURL(file);
    addFileBubble(file.name, file.size, url, 'me');
  }

  $('btnAttach').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) sendFile(file);
    e.target.value = '';
  });

  // ---------- calling (1:1 only) ----------
  let pendingCallOffer = null, inCall = false, callTimerInterval = null, localCallStream = null;

  function setCallView(mode) {
    $('callBar').style.display = mode === 'hidden' ? 'none' : 'flex';
    $('callCalling').style.display = mode === 'calling' ? 'flex' : 'none';
    $('callIncoming').style.display = mode === 'incoming' ? 'flex' : 'none';
    $('callControls').style.display = mode === 'active' ? 'flex' : 'none';
  }
  function startCallTimer() {
    let secs = 0;
    const label = $('callStatus');
    callTimerInterval = setInterval(() => {
      secs++;
      const m = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      label.textContent = 'Voice call \u2014 ' + m + ':' + s;
    }, 1000);
  }
  function stopCallTimer() { clearInterval(callTimerInterval); callTimerInterval = null; }

  function activeContactConn() {
    if (!currentView || currentView.type !== 'contact') return null;
    return connections[currentView.contactId] || null;
  }

  function stopLocalCallStream() {
    if (localCallStream) {
      localCallStream.getTracks().forEach(t => t.stop());
      localCallStream = null;
    }
    const conn = activeContactConn();
    if (conn && conn.pc) {
      conn.pc.getSenders().forEach(sender => {
        if (sender.track) { try { conn.pc.removeTrack(sender); } catch (e) {} }
      });
    }
    $('remoteAudio').srcObject = null;
  }
  function endCallUI(sysMsg) {
    stopLocalCallStream();
    stopCallTimer();
    inCall = false;
    pendingCallOffer = null;
    setCallView('hidden');
    if (sysMsg) addMsg(sysMsg, 'sys');
  }

  async function startCall() {
    const conn = activeContactConn();
    if (!conn || !conn.dc || conn.dc.readyState !== 'open' || inCall) return;
    inCall = true;
    try {
      localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      inCall = false;
      addMsg('Could not access the microphone \u2014 check permissions.', 'sys');
      return;
    }
    try {
      localCallStream.getTracks().forEach(t => conn.pc.addTrack(t, localCallStream));
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);
      await waitIceComplete(conn.pc);
      conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-offer', sdp: conn.pc.localDescription }));
      $('callStatus').textContent = 'Calling\u2026';
      setCallView('calling');
    } catch (err) {
      inCall = false;
      stopLocalCallStream();
      setCallView('hidden');
      console.error('Aegis call (offer) failed:', err);
      addMsg('Could not start the call (' + (err && err.message ? err.message : 'unknown error') + ').', 'sys');
    }
  }

  function handleIncomingCallOffer(conn, obj) {
    if (inCall) {
      encryptObj(conn.sharedAesKey, { t: 'call-decline' }).then(payload => conn.dc.send(payload));
      return;
    }
    pendingCallOffer = obj;
    $('callStatus').textContent = 'Incoming voice call\u2026';
    setCallView('incoming');
  }

  async function acceptCall() {
    const conn = activeContactConn();
    if (!pendingCallOffer || !conn) return;
    const obj = pendingCallOffer;
    inCall = true;
    try {
      localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      inCall = false;
      pendingCallOffer = null;
      setCallView('hidden');
      addMsg('Could not access the microphone \u2014 check permissions.', 'sys');
      conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-decline' }));
      return;
    }
    try {
      await conn.pc.setRemoteDescription(obj.sdp);
      localCallStream.getTracks().forEach(t => conn.pc.addTrack(t, localCallStream));
      const answer = await conn.pc.createAnswer();
      await conn.pc.setLocalDescription(answer);
      await waitIceComplete(conn.pc);
      conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-answer', sdp: conn.pc.localDescription }));
      pendingCallOffer = null;
      setCallView('active');
      startCallTimer();
    } catch (err) {
      inCall = false;
      pendingCallOffer = null;
      stopLocalCallStream();
      setCallView('hidden');
      console.error('Aegis call (answer) failed:', err);
      addMsg('Could not connect the call (' + (err && err.message ? err.message : 'unknown error') + ').', 'sys');
      if (conn.dc && conn.dc.readyState === 'open') conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-decline' }));
    }
  }

  async function declineCall() {
    const conn = activeContactConn();
    if (conn && conn.dc && conn.dc.readyState === 'open') conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-decline' }));
    pendingCallOffer = null;
    setCallView('hidden');
  }

  async function handleCallAnswer(conn, obj) {
    await conn.pc.setRemoteDescription(obj.sdp);
    setCallView('active');
    startCallTimer();
  }

  async function hangup() {
    const conn = activeContactConn();
    if (conn && conn.dc && conn.dc.readyState === 'open') conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-end' }));
    endCallUI('Call ended.');
  }

  $('btnCallAudio').addEventListener('click', startCall);
  $('btnAccept').addEventListener('click', acceptCall);
  $('btnDecline').addEventListener('click', declineCall);
  $('btnHangup').addEventListener('click', hangup);
  $('btnCancelCall').addEventListener('click', hangup);
  $('btnMute').addEventListener('click', () => {
    if (!localCallStream) return;
    const track = localCallStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    $('btnMute').textContent = track.enabled ? 'Mute' : 'Unmute';
  });

  // ---------- sending a message (routes to 1:1 or broadcasts to a group) ----------
  let firstMessageSent = false;

  async function sendMessage() {
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text || !currentView) return;

    if (currentView.type === 'contact') {
      const conn = connections[currentView.contactId];
      if (!conn || !conn.dc || conn.dc.readyState !== 'open') return;
      conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'text', v: text }));
    } else {
      const group = getGroups().filter(g => g.id === currentView.groupId)[0];
      if (!group) return;
      let sentToAny = false;
      for (let i = 0; i < group.memberIds.length; i++) {
        const conn = connections[group.memberIds[i]];
        if (conn && conn.dc && conn.dc.readyState === 'open') {
          conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'text', v: text }));
          sentToAny = true;
        }
      }
      if (!sentToAny) return;
    }

    addMsg(text, 'me');
    input.value = '';
    if (!firstMessageSent) {
      firstMessageSent = true;
      $('step4').style.display = 'none';
    }
  }
  $('btnSend').addEventListener('click', sendMessage);
  $('msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

  // ---------- contacts home navigation ----------
  function resetNewLineUI() {
    $('lineName').value = '';
    $('useRelay').checked = false;
    $('btnHost').disabled = false;
    $('btnJoin').disabled = false;
  }
  $('btnNewLine').addEventListener('click', () => {
    currentView = null;
    $('contactsPanel').style.display = 'none';
    resetNewLineUI();
    markActive($('step1'));
  });
  $('btnBackToContacts').addEventListener('click', () => location.reload());
  $('btnBackToContactsChat').addEventListener('click', () => {
    const conn = activeContactConn();
    if (conn) { try { conn.dc && conn.dc.close(); conn.pc && conn.pc.close(); } catch (e) {} }
    location.reload();
  });
  $('btnForgetLine').addEventListener('click', () => {
    if (!currentView || currentView.type !== 'contact') return;
    if (!confirm('Forget this line? This deletes its saved identity and history from this device.')) return;
    const id = currentView.contactId;
    const contacts = getContacts().filter(c => c.id !== id);
    saveContacts(contacts);
    localStorage.removeItem(historyKey(id));
    const conn = connections[id];
    if (conn) { try { conn.dc && conn.dc.close(); conn.pc && conn.pc.close(); } catch (e) {} }
    location.reload();
  });

  // ---------- role selection (new 1:1 line) ----------
  $('btnHost').addEventListener('click', () => {
    const name = $('lineName').value.trim();
    if (!name) { $('lineName').focus(); return; }
    pendingLineName = name;
    $('btnHost').disabled = true;
    $('btnJoin').disabled = true;
    if ($('useRelay').checked) markActive($('step2hostRelay'));
    else markActive($('step2host'));
  });
  $('btnJoin').addEventListener('click', () => {
    const name = $('lineName').value.trim();
    if (!name) { $('lineName').focus(); return; }
    pendingLineName = name;
    $('btnHost').disabled = true;
    $('btnJoin').disabled = true;
    if ($('useRelay').checked) markActive($('step2joinRelay'));
    else markActive($('step2join'));
  });

  // ---------- HOST flow (manual copy-paste, new line) ----------
  let draftConn = null;
  $('btnCreateOffer').addEventListener('click', async () => {
    $('btnCreateOffer').disabled = true;
    setStatus('offerStatus', 'generating\u2026');
    draftConn = { isHost: true, usingRelay: false, showFingerprint: true, attachHandlers: null };
    draftConn.attachHandlers = () => setupDataChannelHandlersForContact(draftConn);
    $('offerOut').value = await genConnOfferBundle(draftConn);
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
      await acceptConnAnswerBundle(draftConn, $('answerIn').value.trim());
      markDone($('step3host'));
      markActive($('step4'));
      setStatus('connectStatusHost', 'connecting\u2026');
    } catch (err) {
      setStatus('connectStatusHost', 'that reply didn\'t parse \u2014 check it was copied in full', 'err');
    }
  });

  // ---------- JOIN flow (manual copy-paste, new line) ----------
  $('btnCreateAnswer').addEventListener('click', async () => {
    try {
      const conn = { isHost: false, usingRelay: false, showFingerprint: true, attachHandlers: null };
      conn.attachHandlers = () => setupDataChannelHandlersForContact(conn);
      $('answerOut').value = await genConnAnswerBundle(conn, $('offerIn').value.trim());
      $('copyAnswer').disabled = false;
      markActive($('step3join'));
      markActive($('step4'));
    } catch (err) {
      alert('That invite didn\'t parse \u2014 check it was copied in full.');
    }
  });
  $('copyAnswer').addEventListener('click', () => {
    navigator.clipboard.writeText($('answerOut').value);
    $('copyAnswer').textContent = 'Copied';
    setTimeout(() => $('copyAnswer').textContent = 'Copy reply', 1500);
  });

  // ---------- RELAY flow (automatic, via Cloudflare Worker signaling server) ----------
  const SIGNAL_URL = 'wss://aegis-signal.deninluvis.workers.dev';

  function randomRoomCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }
  function connectSignalSocket(room) {
    return new WebSocket(SIGNAL_URL + '?room=' + encodeURIComponent(room));
  }

  // HOST side of the relay (new line)
  $('btnRelayHostStart').addEventListener('click', () => {
    const code = randomRoomCode();
    $('relayHostCode').textContent = code;
    setStatus('relayHostStatus', 'waiting for them to enter this code\u2026');
    $('btnRelayHostStart').disabled = true;

    const conn = { isHost: true, usingRelay: true, roomCode: code, showFingerprint: true, attachHandlers: null };
    conn.attachHandlers = () => setupDataChannelHandlersForContact(conn);

    let ws;
    try { ws = connectSignalSocket(code); }
    catch (err) { setStatus('relayHostStatus', 'could not reach the signaling server \u2014 check SIGNAL_URL is set', 'err'); return; }
    ws.addEventListener('error', () => setStatus('relayHostStatus', 'could not reach the signaling server \u2014 check SIGNAL_URL is set', 'err'));
    ws.addEventListener('message', async (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
      if (msg && msg.t === 'peer-joined') {
        setStatus('relayHostStatus', 'they joined \u2014 exchanging keys\u2026', 'ok');
        ws.send(await genConnOfferBundle(conn));
      } else if (msg && msg.t === 'peer-left') {
        setStatus('relayHostStatus', 'they disconnected before finishing \u2014 have them re-enter the code', 'err');
      } else if (msg && msg.t === 'room-full') {
        setStatus('relayHostStatus', 'that code is already in use \u2014 try again for a new one', 'err');
      } else if (!msg && typeof evt.data === 'string') {
        try {
          await acceptConnAnswerBundle(conn, evt.data);
          markDone($('step2hostRelay'));
          markActive($('step4'));
          ws.close();
        } catch (err) {
          setStatus('relayHostStatus', 'could not complete the connection \u2014 try again', 'err');
        }
      }
    });
  });

  // JOIN side of the relay (new line)
  $('btnRelayJoinConnect').addEventListener('click', () => {
    const code = $('relayJoinCode').value.trim().toUpperCase();
    if (!code) return;
    $('btnRelayJoinConnect').disabled = true;
    setStatus('relayJoinStatus', 'connecting\u2026');

    const conn = { isHost: false, usingRelay: true, roomCode: code, showFingerprint: true, attachHandlers: null };
    conn.attachHandlers = () => setupDataChannelHandlersForContact(conn);

    let ws;
    try { ws = connectSignalSocket(code); }
    catch (err) {
      setStatus('relayJoinStatus', 'could not reach the signaling server \u2014 check SIGNAL_URL is set', 'err');
      $('btnRelayJoinConnect').disabled = false;
      return;
    }
    ws.addEventListener('error', () => {
      setStatus('relayJoinStatus', 'could not reach the signaling server \u2014 check SIGNAL_URL is set', 'err');
      $('btnRelayJoinConnect').disabled = false;
    });
    ws.addEventListener('message', async (evt) => {
      let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
      if (msg && msg.t === 'room-full') {
        setStatus('relayJoinStatus', 'that code already has two people on it', 'err');
        $('btnRelayJoinConnect').disabled = false;
      } else if (msg && msg.t === 'peer-left') {
        setStatus('relayJoinStatus', 'the other side disconnected', 'err');
      } else if (!msg && typeof evt.data === 'string') {
        try {
          setStatus('relayJoinStatus', 'exchanging keys\u2026', 'ok');
          const answerBundle = await genConnAnswerBundle(conn, evt.data);
          ws.send(answerBundle);
          markDone($('step2joinRelay'));
          markActive($('step4'));
        } catch (err) {
          setStatus('relayJoinStatus', 'could not complete the connection \u2014 try again', 'err');
          $('btnRelayJoinConnect').disabled = false;
        }
      }
    });
  });

  // ---------- opening an existing 1:1 contact (reconnect) ----------
  function reconnectFailedFallback(text) {
    setStatus('reconnectStatusLine', text, 'err');
    $('btnReconnectRetry').style.display = 'inline-block';
  }
  $('btnReconnectCancel').addEventListener('click', () => location.reload());
  $('btnReconnectRetry').addEventListener('click', () => {
    const c = getContacts().filter(x => x.id === pendingReconnectContactId)[0];
    if (c) attemptReconnectToContact(c);
  });

  function openContact(id) {
    const contacts = getContacts();
    const contact = contacts.filter(c => c.id === id)[0];
    if (!contact) return;
    $('contactsPanel').style.display = 'none';

    if (!contact.roomCode || !contact.myPub || !contact.myPriv) {
      currentView = { type: 'contact', contactId: contact.id };
      $('chatHeader').style.display = 'flex';
      $('groupChatHeader').style.display = 'none';
      document.body.classList.add('connected');
      $('chat').classList.add('active');
      renderConversationUI(contact);
      addMsg('This line was connected by manual copy-paste, so it can\'t reconnect automatically. Use "Forget this line" and start a new one to talk again.', 'sys', { persist: false });
      return;
    }

    currentView = { type: 'contact', contactId: contact.id };
    pendingReconnectContactId = id;
    renderConversationUI(contact);
    attemptReconnectToContact(contact);
  }

  async function attemptReconnectToContact(contact) {
    const conn = { isHost: contact.isHost, usingRelay: true, roomCode: contact.roomCode, showFingerprint: false, attachHandlers: null, contact: contact };
    conn.attachHandlers = () => setupDataChannelHandlersForContact(conn);

    try {
      conn.myKeyPair = { privateKey: await importPriv(contact.myPriv), publicKey: await importPub(contact.myPub) };
    } catch (err) {
      $('reconnectPanel').style.display = 'block';
      $('reconnectStatus').textContent = contact.name;
      reconnectFailedFallback('could not restore this line\'s identity \u2014 try forgetting and starting fresh');
      return;
    }

    $('reconnectPanel').style.display = 'block';
    $('reconnectStatus').textContent = 'Reconnecting to ' + contact.name + '\u2026';
    setStatus('reconnectStatusLine', 'waiting for them to be online\u2026');
    $('btnReconnectRetry').style.display = 'none';

    let ws;
    try { ws = connectSignalSocket(contact.roomCode); }
    catch (err) { reconnectFailedFallback('could not reach the signaling server'); return; }
    ws.addEventListener('error', () => reconnectFailedFallback('could not reach the signaling server'));

    const trustedPeer = contact.peerPub;
    function isTrustedPeer(pub) { return JSON.stringify(pub) === JSON.stringify(trustedPeer); }

    if (contact.isHost) {
      ws.addEventListener('message', async (evt) => {
        let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
        if (msg && msg.t === 'peer-joined') {
          $('reconnectStatus').textContent = contact.name + ' is back \u2014 reconnecting\u2026';
          ws.send(await genConnOfferBundle(conn));
        } else if (msg && (msg.t === 'peer-left' || msg.t === 'room-full')) {
          reconnectFailedFallback('they\'re not there yet \u2014 try again in a moment');
        } else if (!msg && typeof evt.data === 'string') {
          try {
            const bundle = await acceptConnAnswerBundle(conn, evt.data);
            ws.close();
            if (isTrustedPeer(bundle.pub)) {
              $('step4').style.display = 'none';
            } else {
              const myPubJwk = await exportPub(conn.myKeyPair.publicKey);
              renderFingerprint(await combinedFingerprint(myPubJwk, bundle.pub));
              markActive($('step4'));
              addMsg('Note: ' + contact.name + '\'s key looks different from last time \u2014 please re-check the pattern before trusting the line.', 'sys');
            }
          } catch (err) {
            reconnectFailedFallback('could not reconnect \u2014 try again');
          }
        }
      });
    } else {
      ws.addEventListener('message', async (evt) => {
        let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
        if (msg && msg.t === 'room-full') {
          reconnectFailedFallback('that room already has two people \u2014 try again shortly');
        } else if (msg && msg.t === 'peer-left') {
          reconnectFailedFallback(contact.name + ' disconnected');
        } else if (!msg && typeof evt.data === 'string') {
          try {
            $('reconnectStatus').textContent = 'Reconnecting\u2026';
            const bundle = JSON.parse(atob(evt.data));
            const answerBundle = await genConnAnswerBundle(conn, evt.data);
            ws.send(answerBundle);
            if (isTrustedPeer(bundle.pub)) {
              $('step4').style.display = 'none';
            } else {
              markActive($('step4'));
              addMsg('Note: ' + contact.name + '\'s key looks different from last time \u2014 please re-check the pattern before trusting the line.', 'sys');
            }
          } catch (err) {
            reconnectFailedFallback('could not reconnect \u2014 try again');
          }
        }
      });
    }
  }

  // ---------- groups ----------
  $('btnNewGroup').addEventListener('click', () => {
    $('contactsPanel').style.display = 'none';
    $('groupName').value = '';
    const eligible = relayCapableContacts();
    const picker = $('memberPicker');
    picker.innerHTML = '';
    if (eligible.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'member-picker-empty';
      empty.textContent = 'No short-code lines available yet. Start at least two relay-connected lines first, then come back here.';
      picker.appendChild(empty);
    } else {
      eligible.forEach(c => {
        const label = document.createElement('label');
        label.className = 'member-option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = c.id;
        const span = document.createElement('span');
        span.textContent = c.name;
        label.appendChild(cb);
        label.appendChild(span);
        picker.appendChild(label);
      });
    }
    markActive($('newGroupPanel'));
  });
  $('btnBackFromNewGroup').addEventListener('click', () => location.reload());

  $('btnCreateGroup').addEventListener('click', () => {
    const name = $('groupName').value.trim();
    if (!name) { $('groupName').focus(); return; }
    const checked = $('memberPicker').querySelectorAll('input[type=checkbox]:checked');
    const memberIds = Array.prototype.map.call(checked, cb => cb.value);
    if (memberIds.length < 2) {
      alert('Pick at least two lines to make a group.');
      return;
    }
    const groups = getGroups();
    const id = 'g_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    groups.push({ id: id, name: name, memberIds: memberIds });
    saveGroups(groups);
    location.reload();
  });

  function renderMemberStatusRow(group) {
    const contacts = getContacts();
    const row = $('memberStatusRow');
    row.innerHTML = '';
    group.memberIds.forEach(mid => {
      const contact = contacts.filter(c => c.id === mid)[0];
      const conn = connections[mid];
      const item = document.createElement('div');
      item.className = 'member-status-item';
      const dot = document.createElement('span');
      dot.className = 'dot' + (conn && conn.status === 'open' ? ' ok' : conn && conn.status === 'failed' ? ' err' : '');
      const label = document.createElement('span');
      label.textContent = contact ? contact.name : '(removed)';
      item.appendChild(dot);
      item.appendChild(label);
      row.appendChild(item);
    });
  }

  function openGroup(id) {
    const group = getGroups().filter(g => g.id === id)[0];
    if (!group) return;
    currentView = { type: 'group', groupId: id };
    $('contactsPanel').style.display = 'none';
    document.body.classList.add('connected');
    $('chat').classList.add('active');
    $('chatHeader').style.display = 'none';
    $('groupChatHeader').style.display = 'flex';
    $('groupChatHeaderName').textContent = group.name;
    $('btnAttach').disabled = true;
    $('btnCallAudio').disabled = true;
    $('msgInput').disabled = false;
    $('btnSend').disabled = false;
    renderConversationUI(group);
    renderMemberStatusRow(group);

    const contacts = getContacts();
    group.memberIds.forEach(mid => {
      const contact = contacts.filter(c => c.id === mid)[0];
      if (contact) connectGroupMember(group, contact);
    });
  }

  async function connectGroupMember(group, contact) {
    const conn = { isHost: contact.isHost, usingRelay: true, roomCode: contact.roomCode, showFingerprint: false, status: 'connecting', contact: contact, attachHandlers: null };
    conn.attachHandlers = () => setupDataChannelHandlersForGroupMember(conn, group);
    connections[contact.id] = conn;
    renderMemberStatusRow(group);

    try {
      conn.myKeyPair = { privateKey: await importPriv(contact.myPriv), publicKey: await importPub(contact.myPub) };
    } catch (err) {
      conn.status = 'failed';
      renderMemberStatusRow(group);
      return;
    }

    let ws;
    try { ws = connectSignalSocket(contact.roomCode); }
    catch (err) { conn.status = 'failed'; renderMemberStatusRow(group); return; }
    ws.addEventListener('error', () => { conn.status = 'failed'; renderMemberStatusRow(group); });

    const trustedPeer = contact.peerPub;
    function isTrustedPeer(pub) { return JSON.stringify(pub) === JSON.stringify(trustedPeer); }

    if (contact.isHost) {
      ws.addEventListener('message', async (evt) => {
        let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
        if (msg && msg.t === 'peer-joined') {
          ws.send(await genConnOfferBundle(conn));
        } else if (msg && (msg.t === 'peer-left' || msg.t === 'room-full')) {
          conn.status = 'failed'; renderMemberStatusRow(group);
        } else if (!msg && typeof evt.data === 'string') {
          try {
            const bundle = await acceptConnAnswerBundle(conn, evt.data);
            ws.close();
            if (!isTrustedPeer(bundle.pub)) {
              conn.status = 'failed';
              renderMemberStatusRow(group);
              addMsg(contact.name + '\'s key looks different from last time, so they were not connected to this group for safety. Open their 1:1 line to re-verify.', 'sys');
              try { conn.pc.close(); } catch (e) {}
              delete connections[contact.id];
              return;
            }
          } catch (err) {
            conn.status = 'failed'; renderMemberStatusRow(group);
          }
        }
      });
    } else {
      ws.addEventListener('message', async (evt) => {
        let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
        if (msg && msg.t === 'room-full') { conn.status = 'failed'; renderMemberStatusRow(group); }
        else if (msg && msg.t === 'peer-left') { conn.status = 'failed'; renderMemberStatusRow(group); }
        else if (!msg && typeof evt.data === 'string') {
          try {
            const bundle = JSON.parse(atob(evt.data));
            if (!isTrustedPeer(bundle.pub)) {
              conn.status = 'failed';
              renderMemberStatusRow(group);
              addMsg(contact.name + '\'s key looks different from last time, so they were not connected to this group for safety. Open their 1:1 line to re-verify.', 'sys');
              return;
            }
            const answerBundle = await genConnAnswerBundle(conn, evt.data);
            ws.send(answerBundle);
          } catch (err) {
            conn.status = 'failed'; renderMemberStatusRow(group);
          }
        }
      });
    }
  }

  function setupDataChannelHandlersForGroupMember(conn, group) {
    conn.dc.bufferedAmountLowThreshold = 262144;
    conn.dc.onopen = () => {
      conn.status = 'open';
      renderMemberStatusRow(group);
      requestWakeLock();
    };
    conn.dc.onclose = () => {
      conn.status = 'closed';
      renderMemberStatusRow(group);
      releaseWakeLockIfIdle();
    };
    conn.dc.onmessage = async (e) => {
      try {
        const obj = await decryptObj(conn.sharedAesKey, e.data);
        if (obj.t === 'text') {
          addMsg(obj.v, 'them', { senderName: conn.contact.name });
        }
      } catch (err) {
        addMsg('[could not decrypt a message from ' + conn.contact.name + ']', 'sys');
      }
    };
  }

  $('btnBackToContactsGroup').addEventListener('click', () => {
    if (currentView && currentView.type === 'group') {
      const group = getGroups().filter(g => g.id === currentView.groupId)[0];
      if (group) {
        group.memberIds.forEach(mid => {
          const conn = connections[mid];
          if (conn) { try { conn.dc && conn.dc.close(); conn.pc && conn.pc.close(); } catch (e) {} }
        });
      }
    }
    location.reload();
  });
  $('btnForgetGroup').addEventListener('click', () => {
    if (!currentView || currentView.type !== 'group') return;
    if (!confirm('Forget this group? Its member lines stay saved, but the group and its shared history will be deleted.')) return;
    const id = currentView.groupId;
    const groups = getGroups().filter(g => g.id !== id);
    saveGroups(groups);
    localStorage.removeItem(groupHistoryKey(id));
    Object.keys(connections).forEach(k => {
      const conn = connections[k];
      try { conn.dc && conn.dc.close(); conn.pc && conn.pc.close(); } catch (e) {}
    });
    location.reload();
  });

  renderHomeLists();
})();