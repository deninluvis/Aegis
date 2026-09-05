console.log('[Aegis] script.js executing at', new Date().toISOString(),
  'navType:', (performance.getEntriesByType('navigation')[0] || {}).type,
  'wasDiscarded:', document.wasDiscarded, 'visibility:', document.visibilityState);

(() => {
  const $ = id => document.getElementById(id);

  // connections: contactId -> { pc, dc, myKeyPair, sharedAesKey, peerPubJwk, contact, status, showFingerprint, attachHandlers }
  const connections = {};
  const unreadCounts = {}; // contactId -> unread message count (in-memory, resets on reload)
  let currentView = null; // { type: 'contact', contactId }
  let pendingReconnectContactId = null;

  // ---------- your own identity (shared with peers automatically) ----------
  const USERNAME_KEY = 'aegis_username';
  const AVATAR_KEY = 'aegis_avatar';
  const AVATARS = ['🦊', '🐺', '🦉', '🐙', '🦅', '🐢', '🦋', '🐝', '🐬', '🦁', '🐼', '🐨', '🦔', '🐸', '🦄', '🐧'];
  function getUsername() { return localStorage.getItem(USERNAME_KEY) || ''; }
  function setUsername(name) { localStorage.setItem(USERNAME_KEY, name); renderYouRow(); }
  function getAvatar() { return localStorage.getItem(AVATAR_KEY) || ''; }
  function setAvatar(a) { localStorage.setItem(AVATAR_KEY, a); renderYouRow(); }
  function renderYouRow() {
    const nameEl = $('youName');
    const avatarEl = $('youAvatar');
    if (nameEl) nameEl.textContent = getUsername() || '(not set)';
    if (avatarEl) avatarEl.textContent = getAvatar() || '🙂';
  }

  // ---------- login screen (first run, after Reset, or editing your profile) ----------
  let loginSelectedAvatar = null;
  function renderAvatarGrid() {
    const grid = $('avatarGrid');
    grid.innerHTML = '';
    AVATARS.forEach(a => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'avatar-option' + (a === loginSelectedAvatar ? ' selected' : '');
      btn.textContent = a;
      btn.setAttribute('aria-label', 'Avatar ' + a);
      btn.addEventListener('click', () => {
        loginSelectedAvatar = a;
        Array.from(grid.children).forEach(c => c.classList.remove('selected'));
        btn.classList.add('selected');
        updateLoginContinueState();
      });
      grid.appendChild(btn);
    });
  }
  function updateLoginContinueState() {
    $('btnLoginContinue').disabled = !($('loginName').value.trim() && loginSelectedAvatar);
  }
  function openLoginScreen(isEdit) {
    loginSelectedAvatar = getAvatar() || null;
    $('loginName').value = getUsername();
    renderAvatarGrid();
    updateLoginContinueState();
    $('loginTitle').textContent = isEdit ? 'Edit your profile' : 'Welcome to Aegis';
    $('loginSub').textContent = isEdit
      ? 'Update your name or avatar. Anyone you’re still connected with will see the change next time you talk.'
      : 'Pick a name and an avatar — this is what people you connect with will see. Nothing leaves this device except when you connect to someone.';
    $('btnLoginContinue').textContent = isEdit ? 'Save' : 'Get started';
    $('btnLoginCancel').style.display = isEdit ? 'inline-block' : 'none';
    $('contactsPanel').style.display = 'none';
    $('loginScreen').style.display = 'flex';
  }
  function closeLoginScreen() {
    $('loginScreen').style.display = 'none';
    $('contactsPanel').style.display = 'block';
  }
  $('loginName').addEventListener('input', updateLoginContinueState);
  $('btnLoginCancel').addEventListener('click', closeLoginScreen);
  $('btnLoginContinue').addEventListener('click', () => {
    const name = $('loginName').value.trim();
    if (!name || !loginSelectedAvatar) return;
    setUsername(name);
    setAvatar(loginSelectedAvatar);
    closeLoginScreen();
    renderNotifRow();
    renderHomeLists();
    connectAllHomeLines();
  });
  $('btnEditYouName').addEventListener('click', () => openLoginScreen(true));

  // ---------- notifications (local only — nothing here ever touches a server) ----------
  function renderNotifRow() {
    const stateEl = $('notifState');
    const btn = $('btnEnableNotifs');
    if (!stateEl || !btn) return;
    if (!('Notification' in window)) {
      stateEl.textContent = 'not supported';
      btn.style.display = 'none';
      return;
    }
    const perm = Notification.permission;
    stateEl.textContent = perm === 'granted' ? 'on' : perm === 'denied' ? 'blocked' : 'off';
    btn.textContent = perm === 'granted' ? 'On' : perm === 'denied' ? 'Blocked' : 'Enable';
    btn.disabled = perm !== 'default';
  }
  $('btnEnableNotifs').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    try { await Notification.requestPermission(); } catch (e) {}
    renderNotifRow();
  });
  function contactNotifTitle(contact) {
    return (contact.avatar ? contact.avatar + ' ' : '') + contact.name;
  }
  // Fires for a message/call on a line that isn't the one currently on screen (or the tab is
  // hidden entirely) — never for the conversation you're actively looking at in a visible tab.
  async function notifyForContact(contact, title, body, tagSuffix) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && isViewingContact(contact.id)) return;
    const opts = { body: body, tag: 'aegis-' + contact.id + '-' + (tagSuffix || 'msg'), icon: 'icon-192.png', data: { contactId: contact.id } };
    // Mobile Chrome/Safari reject the page-level Notification() constructor outright and require
    // going through an active service worker instead — try that first, and only fall back to the
    // constructor (desktop browsers without an active registration yet) if it's unavailable.
    if (navigator.serviceWorker) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, opts);
        return;
      } catch (e) {}
    }
    try {
      const n = new Notification(title, opts);
      n.onclick = () => { window.focus(); n.close(); openContact(contact.id); };
    } catch (e) {}
  }

  const STUN = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  // ---------- PWA install support ----------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'aegis-notification-click' && e.data.contactId) {
        openContact(e.data.contactId);
      }
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
  // Offer/answer bundles travel as plain (unencrypted) base64 text — unlike encryptObj/decryptObj,
  // a bare btoa(JSON.stringify(...)) chokes on non-Latin1 characters (e.g. an emoji avatar), so
  // route them through UTF-8 bytes first.
  function bundleToB64(obj) {
    return bytesToB64(new TextEncoder().encode(JSON.stringify(obj)));
  }
  function b64ToBundle(b64) {
    return JSON.parse(new TextDecoder().decode(b64ToBytes(b64)));
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

  function relayCapableContacts() {
    return getContacts().filter(c => c.roomCode && c.myPub && c.myPriv);
  }

  function bumpUnread(id) {
    unreadCounts[id] = (unreadCounts[id] || 0) + 1;
    renderHomeLists();
  }
  function clearUnread(id) {
    if (unreadCounts[id]) { delete unreadCounts[id]; renderHomeLists(); }
  }
  function appendUnreadBadge(row, id) {
    const count = unreadCounts[id];
    if (!count) return;
    const badge = document.createElement('span');
    badge.className = 'unread-badge';
    badge.textContent = count > 9 ? '9+' : String(count);
    row.appendChild(badge);
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
        const conn = connections[c.id];
        // A <div> here, not a <button> — it needs to contain its own forget button, and a button
        // can't validly nest another interactive button.
        const row = document.createElement('div');
        row.className = 'contact-row';
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        const dot = document.createElement('span');
        dot.className = 'dot' + (conn && conn.status === 'open' ? ' ok' : conn && conn.status === 'failed' ? ' err' : '');
        const avatar = document.createElement('span'); avatar.className = 'contact-avatar'; avatar.textContent = c.avatar || '🙂';
        const name = document.createElement('span'); name.className = 'contact-name'; name.textContent = c.name;
        const meta = document.createElement('span'); meta.className = 'contact-meta';
        meta.textContent = !c.roomCode ? 'manual only'
          : conn && conn.status === 'open' ? 'online'
          : conn && conn.status === 'connecting' ? 'connecting…'
          : 'offline';
        row.appendChild(dot); row.appendChild(avatar); row.appendChild(name); row.appendChild(meta);
        appendUnreadBadge(row, c.id);
        const forgetBtn = document.createElement('button');
        forgetBtn.className = 'contact-forget';
        forgetBtn.textContent = '✕';
        forgetBtn.title = 'Forget this line';
        forgetBtn.setAttribute('aria-label', 'Forget ' + c.name);
        forgetBtn.addEventListener('click', (e) => { e.stopPropagation(); forgetContact(c.id); });
        row.appendChild(forgetBtn);
        row.addEventListener('click', () => openContact(c.id));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openContact(c.id); }
        });
        listEl.appendChild(row);
      });
    }
  }

  // ---------- per-conversation local history ----------
  function historyKey(id) { return 'aegis_history_' + id; }
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
    if (key === currentHistoryKey()) updateHistoryBar(key); // don't repaint the bar for a background contact's history
  }
  function historyHasId(key, id) {
    if (!key || !id) return false;
    return loadHistory(key).some(m => m.id === id);
  }
  function genMsgId() {
    return 'm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
      div.className = 'msg ' + m.cls + (m.pending ? ' pending' : '');
      if (m.id) div.dataset.msgId = m.id;
      const body = document.createElement('div');
      body.textContent = m.text;
      div.appendChild(body);
      if (m.pending) {
        const status = document.createElement('div');
        status.className = 'msg-status';
        status.textContent = 'sending…';
        div.appendChild(status);
      }
      log.appendChild(div);
    });
    const divider = document.createElement('div');
    divider.className = 'msg sys';
    divider.textContent = '— saved history above · new session below —';
    log.appendChild(divider);
  }
  function currentHistoryKey() {
    if (!currentView) return null;
    return historyKey(currentView.contactId);
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
    div.className = 'msg ' + cls + (opts.pending ? ' pending' : '');
    if (opts.id) div.dataset.msgId = opts.id;
    const body = document.createElement('div');
    body.textContent = text;
    div.appendChild(body);
    if (opts.pending) {
      const status = document.createElement('div');
      status.className = 'msg-status';
      status.textContent = 'sending…';
      div.appendChild(status);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    if (opts.persist !== false) {
      const key = currentHistoryKey();
      saveHistoryEntry(key, { id: opts.id, text: text, cls: cls, pending: !!opts.pending });
    }
  }
  function markMsgSentInUI(contactId, id) {
    if (!id || !isViewingContact(contactId)) return;
    const el = document.querySelector('.msg[data-msg-id="' + id.replace(/"/g, '') + '"]');
    if (!el) return;
    el.classList.remove('pending');
    const status = el.querySelector('.msg-status');
    if (status) status.remove();
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

  // ---------- recover from a frozen/back-forward-cached tab ----------
  // A tab that gets suspended (closed to the OS task switcher, or restored via the browser's
  // back-forward cache) can resume with its old JS state intact but its actual sockets long dead —
  // the UI would then show stale "online" dots for lines that aren't really connected anymore.
  function dropStaleConnections() {
    let hadStale = false;
    Object.keys(connections).forEach(id => {
      const conn = connections[id];
      if (conn.status === 'open' && (!conn.dc || conn.dc.readyState !== 'open')) {
        closeConnection(id);
        hadStale = true;
      }
    });
    if (hadStale) { renderHomeLists(); connectAllHomeLines(); }
  }
  window.addEventListener('pageshow', (e) => { if (e.persisted) dropStaleConnections(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') dropStaleConnections();
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
    return bundleToB64({ sdp: conn.pc.localDescription, pub: pubJwk, name: getUsername(), avatar: getAvatar() });
  }

  async function acceptConnAnswerBundle(conn, raw) {
    const bundle = b64ToBundle(raw);
    await conn.pc.setRemoteDescription(bundle.sdp);
    const theirPub = await importPub(bundle.pub);
    conn.sharedAesKey = await deriveShared(conn.myKeyPair.privateKey, theirPub);
    conn.peerPubJwk = bundle.pub;
    conn.peerName = bundle.name || conn.peerName;
    conn.peerAvatar = bundle.avatar || conn.peerAvatar;
    if (conn.showFingerprint) {
      const myPubJwk = await exportPub(conn.myKeyPair.publicKey);
      renderFingerprint(await combinedFingerprint(myPubJwk, bundle.pub));
    }
    return bundle;
  }

  async function genConnAnswerBundle(conn, raw) {
    const bundle = b64ToBundle(raw);
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
    conn.peerName = bundle.name || conn.peerName;
    conn.peerAvatar = bundle.avatar || conn.peerAvatar;
    if (conn.showFingerprint) {
      const myPubJwk = await exportPub(conn.myKeyPair.publicKey);
      renderFingerprint(await combinedFingerprint(myPubJwk, bundle.pub));
    }

    const myPubJwk2 = await exportPub(conn.myKeyPair.publicKey);
    return bundleToB64({ sdp: conn.pc.localDescription, pub: myPubJwk2, name: getUsername(), avatar: getAvatar() });
  }

  // ---------- 1:1 data channel handlers (new line + reconnect) ----------
  async function finalizeContactOnConnect(conn) {
    const contacts = getContacts();
    if (currentView && currentView.type === 'contact' && conn.contact && conn.contact.id) {
      const c = contacts.find(x => x.id === conn.contact.id);
      if (c && conn.peerPubJwk) { c.peerPub = conn.peerPubJwk; saveContacts(contacts); }
      if (c && ((conn.peerName && conn.peerName !== c.name) || (conn.peerAvatar && conn.peerAvatar !== c.avatar))) {
        if (conn.peerName) c.name = conn.peerName;
        if (conn.peerAvatar) c.avatar = conn.peerAvatar;
        saveContacts(contacts);
        Object.assign(conn.contact, { name: c.name, avatar: c.avatar });
      }
      connections[c ? c.id : conn.contact.id] = conn;
      renderConversationUI(c || conn.contact);
      return;
    }
    const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const contact = { id: id, name: conn.peerName || 'Unnamed', avatar: conn.peerAvatar || '', isHost: conn.isHost, roomCode: conn.usingRelay ? conn.roomCode : null, peerPub: conn.peerPubJwk, myPub: null, myPriv: null };
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

  function renderConversationUI(contact) {
    $('chatHeaderName').textContent = contact.name;
    $('chatHeaderAvatar').textContent = contact.avatar || '🙂';
    const log = $('chatLog');
    log.innerHTML = '';
    renderSavedHistory(currentHistoryKey());
    updateHistoryBar(currentHistoryKey());
  }

  function setupDataChannelHandlersForContact(conn) {
    conn.dc.bufferedAmountLowThreshold = 262144;
    // Same reasoning as the background handler: the remote side closing abruptly can leave the data
    // channel's own close event lagging — react to the peer connection's aggregate state instead.
    let disconnectGraceTimer = null;
    conn.pc.onconnectionstatechange = () => {
      const state = conn.pc.connectionState;
      if (state === 'connected' && disconnectGraceTimer) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
      if (state === 'failed') {
        try { conn.dc.close(); } catch (e) {}
      } else if (state === 'disconnected' && !disconnectGraceTimer) {
        disconnectGraceTimer = setTimeout(() => {
          disconnectGraceTimer = null;
          if (conn.pc.connectionState !== 'connected') { try { conn.dc.close(); } catch (e) {} }
        }, 5000);
      }
    };
    conn.dc.onopen = async () => {
      conn.status = 'open';
      $('chat').classList.add('active');
      $('msgInput').disabled = false;
      $('btnSend').disabled = false;
      $('btnAttach').disabled = false;
      $('btnCallAudio').disabled = false;
      document.body.classList.add('connected');
      ['step1', 'step2host', 'step3host', 'step2join', 'step3join', 'step2hostRelay', 'step2joinRelay', 'reconnectPanel', 'contactsPanel'].forEach(id => {
        $(id).style.display = 'none';
      });
      $('chatHeader').style.display = 'flex';

      await finalizeContactOnConnect(conn);
      await flushOutbox(conn);

      addMsg('Line connected. Messages below are end-to-end encrypted.', 'sys');
      if (conn.isHost) setStatus('connectStatusHost', 'connected', 'ok');
      else setStatus('connectStatusJoin', 'connected', 'ok');
      requestWakeLock();
    };
    conn.dc.onclose = () => {
      conn.status = 'closed';
      if (activeCallContactId === conn.contact.id && (inCall || pendingCallOffer)) endCallUI();
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

  // Send any messages composed while offline (queued as pending) once the line reopens — this is
  // how both sides' histories converge after a reconnect, since there's no server to hold messages.
  async function flushOutbox(conn) {
    if (!conn.contact || !conn.dc || conn.dc.readyState !== 'open') return;
    const key = historyKey(conn.contact.id);
    const hist = loadHistory(key);
    let changed = false;
    for (const entry of hist) {
      if (entry.cls === 'me' && entry.pending && entry.id) {
        try {
          conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'text', id: entry.id, v: entry.text }));
          entry.pending = false;
          changed = true;
          markMsgSentInUI(conn.contact.id, entry.id);
        } catch (e) { break; }
      }
    }
    if (changed) localStorage.setItem(key, JSON.stringify(hist));
  }

  async function handleContactMessage(conn, obj) {
    if (obj.t === 'text') {
      if (!historyHasId(historyKey(conn.contact.id), obj.id)) {
        addMsg(obj.v, 'them', { id: obj.id });
        notifyForContact(conn.contact, contactNotifTitle(conn.contact), obj.v);
      }
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
      if (activeCallContactId === conn.contact.id) endCallUI('Call declined.');
    } else if (obj.t === 'call-end') {
      if (activeCallContactId === conn.contact.id) endCallUI('Call ended.');
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

  // ---------- calling (1:1 only, works from any screen — home or chat) ----------
  let pendingCallOffer = null, inCall = false, callTimerInterval = null, localCallStream = null;
  let activeCallContactId = null; // which line the call belongs to — independent of currentView, so it survives navigating home

  function callConn() {
    return activeCallContactId ? (connections[activeCallContactId] || null) : null;
  }
  function activeCallContactName() {
    const conn = callConn();
    return (conn && conn.contact && conn.contact.name) || 'them';
  }

  function setCallView(mode) {
    $('callBar').style.display = mode === 'hidden' ? 'none' : 'flex';
    $('callCalling').style.display = mode === 'calling' ? 'flex' : 'none';
    $('callIncoming').style.display = mode === 'incoming' ? 'flex' : 'none';
    $('callControls').style.display = mode === 'active' ? 'flex' : 'none';
  }
  function startCallTimer() {
    let secs = 0;
    const label = $('callStatus');
    const name = activeCallContactName();
    callTimerInterval = setInterval(() => {
      secs++;
      const m = String(Math.floor(secs / 60)).padStart(2, '0');
      const s = String(secs % 60).padStart(2, '0');
      label.textContent = 'Voice call with ' + name + ' \u2014 ' + m + ':' + s;
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
    const conn = callConn();
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
    if (sysMsg) recordCallSysMsg(activeCallContactId, sysMsg);
    activeCallContactId = null;
  }

  // A call can end while we're not viewing that contact's chat (e.g. on the home screen) —
  // render live only if it's the open conversation, otherwise just save it to that line's history.
  function recordCallSysMsg(contactId, text) {
    if (isViewingContact(contactId)) {
      addMsg(text, 'sys');
    } else if (contactId) {
      saveHistoryEntry(historyKey(contactId), { text: text, cls: 'sys-file' });
    }
  }
  function isViewingContact(contactId) {
    return !!(contactId && currentView && currentView.type === 'contact' && currentView.contactId === contactId);
  }

  async function startCall() {
    if (!currentView || currentView.type !== 'contact') return;
    const conn = connections[currentView.contactId];
    if (!conn || !conn.dc || conn.dc.readyState !== 'open' || inCall) return;
    activeCallContactId = currentView.contactId;
    inCall = true;
    try {
      localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      inCall = false;
      recordCallSysMsg(activeCallContactId, 'Could not access the microphone \u2014 check permissions.');
      activeCallContactId = null;
      return;
    }
    try {
      localCallStream.getTracks().forEach(t => conn.pc.addTrack(t, localCallStream));
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);
      await waitIceComplete(conn.pc);
      conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-offer', sdp: conn.pc.localDescription }));
      $('callStatus').textContent = 'Calling ' + activeCallContactName() + '\u2026';
      setCallView('calling');
    } catch (err) {
      inCall = false;
      stopLocalCallStream();
      setCallView('hidden');
      console.error('Aegis call (offer) failed:', err);
      recordCallSysMsg(activeCallContactId, 'Could not start the call (' + (err && err.message ? err.message : 'unknown error') + ').');
      activeCallContactId = null;
    }
  }

  function handleIncomingCallOffer(conn, obj) {
    if (inCall) {
      encryptObj(conn.sharedAesKey, { t: 'call-decline' }).then(payload => conn.dc.send(payload));
      return;
    }
    activeCallContactId = conn.contact.id;
    pendingCallOffer = obj;
    $('callStatus').textContent = 'Incoming voice call from ' + conn.contact.name + '\u2026';
    setCallView('incoming');
    notifyForContact(conn.contact, contactNotifTitle(conn.contact), 'Incoming voice call\u2026', 'call');
  }

  async function acceptCall() {
    const conn = callConn();
    if (!pendingCallOffer || !conn) return;
    const obj = pendingCallOffer;
    inCall = true;
    try {
      localCallStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      inCall = false;
      pendingCallOffer = null;
      setCallView('hidden');
      recordCallSysMsg(activeCallContactId, 'Could not access the microphone \u2014 check permissions.');
      conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-decline' }));
      activeCallContactId = null;
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
      recordCallSysMsg(activeCallContactId, 'Could not connect the call (' + (err && err.message ? err.message : 'unknown error') + ').');
      if (conn.dc && conn.dc.readyState === 'open') conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-decline' }));
      activeCallContactId = null;
    }
  }

  async function declineCall() {
    const conn = callConn();
    if (conn && conn.dc && conn.dc.readyState === 'open') conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'call-decline' }));
    pendingCallOffer = null;
    activeCallContactId = null;
    setCallView('hidden');
  }

  async function handleCallAnswer(conn, obj) {
    await conn.pc.setRemoteDescription(obj.sdp);
    setCallView('active');
    startCallTimer();
  }

  async function hangup() {
    const conn = callConn();
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

  // ---------- sending a message ----------
  let firstMessageSent = false;

  async function sendMessage() {
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text || !currentView || currentView.type !== 'contact') return;

    const conn = connections[currentView.contactId];
    const id = genMsgId();
    const open = !!(conn && conn.dc && conn.dc.readyState === 'open');
    // If the line isn't open yet (still reconnecting), queue the message as pending instead of
    // dropping it — it gets sent automatically once the data channel opens (see flushOutbox).
    if (open) conn.dc.send(await encryptObj(conn.sharedAesKey, { t: 'text', id: id, v: text }));

    addMsg(text, 'me', { id: id, pending: !open });
    input.value = '';
    if (!firstMessageSent) {
      firstMessageSent = true;
      $('step4').style.display = 'none';
    }
  }
  $('btnSend').addEventListener('click', sendMessage);
  $('msgInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });

  // ---------- contacts home navigation ----------
  function goHome() {
    currentView = null;
    ['step1', 'step2host', 'step3host', 'step2join', 'step3join', 'step2hostRelay', 'step2joinRelay', 'reconnectPanel'].forEach(id => {
      $(id).style.display = 'none';
    });
    document.body.classList.remove('connected');
    $('chat').classList.remove('active');
    $('chatHeader').style.display = 'none';
    $('msgInput').disabled = true;
    $('btnSend').disabled = true;
    $('btnAttach').disabled = true;
    $('btnCallAudio').disabled = true;
    $('chatLog').innerHTML = '';
    $('historyBar').style.display = 'none';
    $('contactsPanel').style.display = 'block';
    renderHomeLists();
  }

  function resetNewLineUI() {
    $('lineName').value = getUsername();
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

  $('btnClearEverything').addEventListener('click', () => {
    if (!confirm('Erase everything? This deletes every saved line and message history from this device. This cannot be undone.')) return;
    if (prompt('Type ERASE to confirm.') !== 'ERASE') return;
    Object.keys(connections).forEach(id => {
      const conn = connections[id];
      try { conn.dc && conn.dc.close(); conn.pc && conn.pc.close(); } catch (e) {}
    });
    Object.keys(localStorage).filter(k => k.startsWith('aegis_')).forEach(k => localStorage.removeItem(k));
    location.reload();
  });
  $('btnBackToContactsChat').addEventListener('click', () => {
    const conn = activeContactConn();
    // A call (or a pending incoming offer) keeps running via the global call bar — no need to end it here.
    if (conn && conn.dc && conn.dc.readyState === 'open') {
      setupBackgroundContactHandlers(conn); // keep the line alive on the home screen instead of closing it
    } else if (conn) {
      const id = currentView.contactId;
      try { conn.dc && conn.dc.close(); conn.pc && conn.pc.close(); } catch (e) {}
      delete connections[id];
    }
    goHome();
  });
  function forgetContact(id) {
    const contact = getContacts().find(c => c.id === id);
    if (!confirm('Forget ' + (contact ? contact.name : 'this line') + '? This deletes its saved identity and history from this device.')) return;
    saveContacts(getContacts().filter(c => c.id !== id));
    localStorage.removeItem(historyKey(id));
    delete unreadCounts[id];
    closeConnection(id);
    if (currentView && currentView.type === 'contact' && currentView.contactId === id) {
      location.reload();
    } else {
      renderHomeLists();
    }
  }
  $('btnForgetLine').addEventListener('click', () => {
    if (!currentView || currentView.type !== 'contact') return;
    forgetContact(currentView.contactId);
  });

  // ---------- role selection (new 1:1 line) ----------
  $('btnHost').addEventListener('click', () => {
    const name = $('lineName').value.trim();
    if (!name) { $('lineName').focus(); return; }
    setUsername(name);
    $('btnHost').disabled = true;
    $('btnJoin').disabled = true;
    if ($('useRelay').checked) markActive($('step2hostRelay'));
    else markActive($('step2host'));
  });
  $('btnJoin').addEventListener('click', () => {
    const name = $('lineName').value.trim();
    if (!name) { $('lineName').focus(); return; }
    setUsername(name);
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
    $('btnCopyRelayCode').disabled = false;
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
        if (!conn.pc) setStatus('relayHostStatus', 'they disconnected before finishing \u2014 have them re-enter the code', 'err');
      } else if (msg && msg.t === 'room-full') {
        if (!conn.pc) setStatus('relayHostStatus', 'that code is already in use \u2014 try again for a new one', 'err');
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

  $('btnCopyRelayCode').addEventListener('click', () => {
    navigator.clipboard.writeText($('relayHostCode').textContent);
    $('btnCopyRelayCode').textContent = 'Copied';
    setTimeout(() => $('btnCopyRelayCode').textContent = 'Copy code', 1500);
  });

  // JOIN side of the relay (new line)
  $('btnPasteRelayCode').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      $('relayJoinCode').value = text.trim().toUpperCase();
    } catch (err) {
      $('relayJoinCode').focus();
    }
  });
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
        if (!conn.pc) {
          setStatus('relayJoinStatus', 'that code already has two people on it', 'err');
          $('btnRelayJoinConnect').disabled = false;
        }
      } else if (msg && msg.t === 'peer-left') {
        if (!conn.pc) setStatus('relayJoinStatus', 'the other side disconnected', 'err');
      } else if (!msg && typeof evt.data === 'string') {
        try {
          setStatus('relayJoinStatus', 'exchanging keys\u2026', 'ok');
          const answerBundle = await genConnAnswerBundle(conn, evt.data);
          ws.send(answerBundle);
          ws.close();
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
    clearUnread(id);

    if (!contact.roomCode || !contact.myPub || !contact.myPriv) {
      currentView = { type: 'contact', contactId: contact.id };
      $('chatHeader').style.display = 'flex';
      document.body.classList.add('connected');
      $('chat').classList.add('active');
      renderConversationUI(contact);
      addMsg('This line was connected by manual copy-paste, so it can\'t reconnect automatically. Use "Forget this line" and start a new one to talk again.', 'sys', { persist: false });
      return;
    }

    const existing = connections[id];
    if (existing && existing.status === 'open') {
      // Already connected in the background — attach to it instead of tearing down a live
      // connection just to renegotiate a new one (which would also drop the other side).
      currentView = { type: 'contact', contactId: contact.id };
      document.body.classList.add('connected');
      $('chat').classList.add('active');
      $('msgInput').disabled = false;
      $('btnSend').disabled = false;
      $('btnAttach').disabled = false;
      $('btnCallAudio').disabled = false;
      $('chatHeader').style.display = 'flex';
      renderConversationUI(contact);
      setupDataChannelHandlersForContact(existing); // switch from silent background handling to live foreground handling
      addMsg('Line connected. Messages below are end-to-end encrypted.', 'sys');
      return;
    }

    // Drop any background presence connection so the foreground flow below gets a clean handshake.
    closeConnection(id);

    currentView = { type: 'contact', contactId: contact.id };
    pendingReconnectContactId = id;
    renderConversationUI(contact);
    // Show the chat (and let them type) right away, even though the line isn't back up yet —
    // anything sent now queues locally and goes out as soon as the reconnect finishes.
    document.body.classList.add('connected');
    $('chat').classList.add('active');
    $('chatHeader').style.display = 'flex';
    $('msgInput').disabled = false;
    $('btnSend').disabled = false;
    $('btnAttach').disabled = true;
    $('btnCallAudio').disabled = true;
    attemptReconnectToContact(contact);
  }

  async function attemptReconnectToContact(contact) {
    const conn = { isHost: contact.isHost, usingRelay: true, roomCode: contact.roomCode, showFingerprint: false, status: 'connecting', attachHandlers: null, contact: contact };
    conn.attachHandlers = () => setupDataChannelHandlersForContact(conn);

    try {
      conn.myKeyPair = { privateKey: await importPriv(contact.myPriv), publicKey: await importPub(contact.myPub) };
    } catch (err) {
      markActive($('reconnectPanel'));
      $('reconnectStatus').textContent = contact.name;
      reconnectFailedFallback('could not restore this line\'s identity \u2014 try forgetting and starting fresh');
      return;
    }

    markActive($('reconnectPanel'));
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
          setTimeout(() => { if (conn.status === 'connecting') reconnectFailedFallback('could not reconnect \u2014 try again'); }, NEGOTIATE_TIMEOUT_MS);
          ws.send(await genConnOfferBundle(conn));
        } else if (msg && (msg.t === 'peer-left' || msg.t === 'room-full')) {
          // Once we have a pc, the peer's own signaling socket closing (which it does right after
          // finishing its side) looks identical to a real disconnect \u2014 ignore it once negotiating.
          if (!conn.pc) reconnectFailedFallback('they\'re not there yet \u2014 try again in a moment');
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
          if (!conn.pc) reconnectFailedFallback('that room already has two people \u2014 try again shortly');
        } else if (msg && msg.t === 'peer-left') {
          if (!conn.pc) reconnectFailedFallback(contact.name + ' disconnected');
        } else if (!msg && typeof evt.data === 'string') {
          try {
            $('reconnectStatus').textContent = 'Reconnecting\u2026';
            setTimeout(() => { if (conn.status === 'connecting') reconnectFailedFallback('could not reconnect \u2014 try again'); }, NEGOTIATE_TIMEOUT_MS);
            const bundle = b64ToBundle(evt.data);
            const answerBundle = await genConnAnswerBundle(conn, evt.data);
            ws.send(answerBundle);
            ws.close();
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

  // ---------- keep saved lines connected in the background (home screen presence + unread) ----------
  const BACKGROUND_RETRY_MS = 20000;
  const NEGOTIATE_TIMEOUT_MS = 15000; // cap on the active WebRTC handshake, once both sides have shown up in the relay room

  function dropBackgroundConn(conn, reason) {
    if (connections[conn.contact.id] !== conn) return; // already handled (e.g. taken over in the foreground)
    console.log('[Aegis bg:' + conn.contact.name + ']', 'dropping connection:', reason);
    conn.status = 'closed';
    if (activeCallContactId === conn.contact.id && (inCall || pendingCallOffer)) endCallUI('Call ended.');
    delete connections[conn.contact.id];
    try { conn.dc && conn.dc.close(); } catch (e) {}
    try { conn.pc && conn.pc.close(); } catch (e) {}
    releaseWakeLockIfIdle();
    renderHomeLists();
    setTimeout(() => connectContactInBackground(conn.contact), BACKGROUND_RETRY_MS);
  }

  function setupBackgroundContactHandlers(conn) {
    conn.dc.bufferedAmountLowThreshold = 262144;
    // The remote side closing abruptly (browser closed, not a clean disconnect) can leave the data
    // channel's own close event lagging far behind — the peer connection's aggregate state notices
    // a dead link much sooner, so use it to retry quickly instead of waiting on dc.onclose alone.
    let disconnectGraceTimer = null;
    conn.pc.onconnectionstatechange = () => {
      const state = conn.pc.connectionState;
      if (state === 'connected' && disconnectGraceTimer) { clearTimeout(disconnectGraceTimer); disconnectGraceTimer = null; }
      if (state === 'failed') {
        dropBackgroundConn(conn, 'pc failed');
      } else if (state === 'disconnected' && !disconnectGraceTimer) {
        // Brief blips can self-recover — give it a few seconds before treating it as really gone.
        disconnectGraceTimer = setTimeout(() => {
          disconnectGraceTimer = null;
          if (conn.pc.connectionState !== 'connected') dropBackgroundConn(conn, 'pc disconnected');
        }, 5000);
      }
    };
    conn.dc.onopen = () => {
      console.log('[Aegis bg:' + conn.contact.name + ']', 'data channel OPEN');
      conn.status = 'open';
      if ((conn.peerName && conn.peerName !== conn.contact.name) || (conn.peerAvatar && conn.peerAvatar !== conn.contact.avatar)) {
        const contacts = getContacts();
        const c = contacts.find(x => x.id === conn.contact.id);
        if (c) {
          if (conn.peerName) c.name = conn.peerName;
          if (conn.peerAvatar) c.avatar = conn.peerAvatar;
          saveContacts(contacts);
          Object.assign(conn.contact, { name: c.name, avatar: c.avatar });
        }
      }
      requestWakeLock();
      flushOutbox(conn);
      renderHomeLists();
    };
    conn.dc.onclose = () => dropBackgroundConn(conn, 'dc closed');
    conn.dc.onmessage = async (e) => {
      try {
        const obj = await decryptObj(conn.sharedAesKey, e.data);
        if (obj.t === 'text') {
          const key = historyKey(conn.contact.id);
          if (!historyHasId(key, obj.id)) {
            saveHistoryEntry(key, { id: obj.id, text: obj.v, cls: 'them' });
            bumpUnread(conn.contact.id);
            notifyForContact(conn.contact, contactNotifTitle(conn.contact), obj.v);
          }
        } else if (obj.t === 'call-offer') {
          handleIncomingCallOffer(conn, obj);
        } else if (obj.t === 'call-answer') {
          await handleCallAnswer(conn, obj);
        } else if (obj.t === 'call-decline') {
          if (activeCallContactId === conn.contact.id) endCallUI('Call declined.');
        } else if (obj.t === 'call-end') {
          if (activeCallContactId === conn.contact.id) endCallUI('Call ended.');
        }
      } catch (err) {}
    };
  }

  function connectContactInBackground(contact) {
    if (connections[contact.id]) return; // already connecting/open in background or in the foreground

    const log = (...args) => console.log('[Aegis bg:' + contact.name + ']', ...args);
    log('starting background connect, room', contact.roomCode, 'isHost', contact.isHost);

    const conn = { isHost: contact.isHost, usingRelay: true, roomCode: contact.roomCode, showFingerprint: false, status: 'connecting', contact: contact, attachHandlers: null, ws: null };
    conn.attachHandlers = () => setupBackgroundContactHandlers(conn);
    connections[contact.id] = conn;
    renderHomeLists();

    const fail = (reason) => {
      if (connections[contact.id] !== conn) return; // already failed/replaced once
      log('failed:', reason);
      conn.status = 'failed';
      renderHomeLists();
      delete connections[contact.id];
      // Always release our own relay socket before giving up — an unclosed one sits in the
      // 2-person room and blocks the real peer (or a later manual reconnect) from ever getting in.
      try { conn.ws && conn.ws.close(); } catch (e) {}
      try { conn.pc && conn.pc.close(); } catch (e) {}
      setTimeout(() => connectContactInBackground(contact), BACKGROUND_RETRY_MS);
    };

    (async () => {
      try {
        conn.myKeyPair = { privateKey: await importPriv(contact.myPriv), publicKey: await importPub(contact.myPub) };
      } catch (err) { fail('bad stored keys: ' + err.message); return; }

      let ws;
      try { ws = connectSignalSocket(contact.roomCode); }
      catch (err) { fail('could not open signaling socket: ' + err.message); return; }
      conn.ws = ws;
      ws.addEventListener('open', () => log('signaling socket open, waiting in room'));
      ws.addEventListener('error', () => fail('signaling socket error'));
      ws.addEventListener('close', (evt) => log('signaling socket closed', evt.code, evt.reason));

      if (contact.isHost) {
        ws.addEventListener('message', async (evt) => {
          let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
          if (msg && msg.t === 'peer-joined') {
            log('peer joined, sending offer');
            // WebRTC negotiation is starting now — cap it so a NAT/ICE failure surfaces as a
            // retry instead of leaving the line stuck showing "connecting…" forever.
            setTimeout(() => { if (conn.status === 'connecting') fail('negotiation timed out after offer'); }, NEGOTIATE_TIMEOUT_MS);
            ws.send(await genConnOfferBundle(conn));
          } else if (msg && (msg.t === 'peer-left' || msg.t === 'room-full')) {
            // Once negotiation has started, the peer's own signaling socket closing (which it does
            // right after finishing its side) looks identical to a real disconnect — ignore it and
            // let the actual WebRTC connection state (dc open/close, or the timeout above) decide.
            if (!conn.pc) fail('relay said: ' + msg.t);
          } else if (!msg && typeof evt.data === 'string') {
            log('got answer, accepting');
            try { await acceptConnAnswerBundle(conn, evt.data); ws.close(); }
            catch (err) { fail('accepting answer threw: ' + err.message); }
          }
        });
      } else {
        ws.addEventListener('message', async (evt) => {
          let msg; try { msg = JSON.parse(evt.data); } catch (e) { msg = null; }
          if (msg && (msg.t === 'room-full' || msg.t === 'peer-left')) {
            if (!conn.pc) fail('relay said: ' + msg.t);
          } else if (!msg && typeof evt.data === 'string') {
            log('got offer, sending answer');
            try {
              setTimeout(() => { if (conn.status === 'connecting') fail('negotiation timed out after answer'); }, NEGOTIATE_TIMEOUT_MS);
              const answerBundle = await genConnAnswerBundle(conn, evt.data);
              ws.send(answerBundle);
              ws.close();
            } catch (err) { fail('generating/sending answer threw: ' + err.message); }
          }
        });
      }
    })();
  }

  function closeConnection(id) {
    const conn = connections[id];
    if (!conn) return;
    try { conn.ws && conn.ws.close(); } catch (e) {}
    try { conn.dc && conn.dc.close(); } catch (e) {}
    try { conn.pc && conn.pc.close(); } catch (e) {}
    delete connections[id];
  }

  function connectAllHomeLines() {
    relayCapableContacts().forEach(contact => connectContactInBackground(contact));
  }

  if (!getUsername() || !getAvatar()) {
    openLoginScreen(false);
  } else {
    $('contactsPanel').style.display = 'block';
    renderYouRow();
    renderNotifRow();
    renderHomeLists();
    connectAllHomeLines();
  }
})();