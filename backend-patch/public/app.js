(() => {
  'use strict';

  const socket = io();

  // ---------- state ----------
  let me = null; // {id, username, color}
  let typingTimeout = null;
  let othersTyping = new Map(); // id -> username

  // screen share state
  let localStream = null;
  let sharing = false;
  const sharerConnections = new Map();  // viewerId -> RTCPeerConnection (I am sharing)
  const viewerConnections = new Map();  // sharerId -> RTCPeerConnection (I am watching)
  const pendingCandidates = new Map();  // peerId -> [candidates] queued before remoteDescription set
  const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const joinScreen = $('joinScreen'), joinHint = $('joinHint');
  const app = $('app'), peerCount = $('peerCount'), peerCountMobile = $('peerCountMobile');
  const userList = $('userList'), shareList = $('shareList');
  const messagesEl = $('messages'), typingIndicator = $('typingIndicator');
  const messageInput = $('messageInput'), sendBtn = $('sendBtn');
  const attachBtn = $('attachBtn'), fileInput = $('fileInput');
  const dropZone = $('dropZone'), dragOverlay = $('dragOverlay');
  const sidebar = $('sidebar'), sidebarOverlay = $('sidebarOverlay'), menuBtn = $('menuBtn');
  const themeBtn = $('themeBtn');
  const meBtn = $('meBtn'), meName = $('meName');
  const broadcastBtn = $('broadcastBtn'), broadcastModal = $('broadcastModal'), broadcastInput = $('broadcastInput');
  const broadcastCancelBtn = $('broadcastCancelBtn'), broadcastSendBtn = $('broadcastSendBtn');
  const shareScreenBtn = $('shareScreenBtn');
  const viewerModal = $('viewerModal'), viewerVideo = $('viewerVideo'), viewerTitle = $('viewerTitle'), closeViewerBtn = $('closeViewerBtn');
  const pmPanel = $('pmPanel'), pmCloseBtn = $('pmCloseBtn'), pmMessages = $('pmMessages');
  const pmHeadName = $('pmHeadName'), pmHeadDot = $('pmHeadDot'), pmTypingIndicator = $('pmTypingIndicator');
  const pmMessageInput = $('pmMessageInput'), pmSendBtn = $('pmSendBtn');
  const pmAttachBtn = $('pmAttachBtn'), pmFileInput = $('pmFileInput');

  // ---------- join (automatic — no typing needed) ----------
  // Naam ek baar decide hone ke baad browser mai (localStorage) yaad rakha jaata hai,
  // taaki har baar dobara na poochna pade. Pehli baar server khud device ka
  // network hostname (computer ka naam) use karne ki koshish karta hai.
  // NOTE: key ko versioned rakha hai (v2) taaki purane test session me galat
  // "Guest-xxxx" naam save ho gaya ho to wo automatically clear ho jaye aur
  // naya, sahi (computer-name-based) detection dobara chale.
  const SAVED_NAME_KEY = 'lanchat:username:v2';
  localStorage.removeItem('lanchat:username'); // purana (v1) cached naam hata dein
  function join() {
    const saved = (localStorage.getItem(SAVED_NAME_KEY) || '').trim();
    socket.emit('join', { username: saved });
  }
  socket.on('connect', join);

  socket.on('joined', (data) => {
    me = data;
    localStorage.setItem(SAVED_NAME_KEY, data.username);
    meName.textContent = data.username;
    joinScreen.classList.add('hidden');
    app.classList.remove('hidden');
    messageInput.focus();
  });

  // ---------- rename ----------
  meBtn.addEventListener('click', () => {
    const current = me ? me.username : '';
    const next = window.prompt('Naya naam likhein:', current);
    if (next === null) return;
    const clean = next.trim().slice(0, 24);
    if (!clean || clean === current) return;
    socket.emit('rename', { username: clean });
  });

  // Server se aayi saved chat history (backend par compressed JSON file se load hoti hai)
  socket.on('chat:history', (history) => {
    // Pehle purane render ko clear karte hain — warna agar socket kabhi
    // reconnect ho (WiFi jump, tab wapas active hona, etc.) to yeh event
    // dobara aayega aur messages doubled/duplicate dikhne lagenge.
    messagesEl.innerHTML = '';
    if (!Array.isArray(history) || history.length === 0) return;
    history.forEach((entry) => {
      if (entry.type === 'system') {
        addSystemMessage(entry.text);
      } else if (entry.type === 'chat') {
        renderChatMessage(entry);
      } else if (entry.type === 'file') {
        addSystemMessage(`${entry.username} sent a file: ${entry.name} (${formatSize(entry.size)}) — history only, download expired`);
      }
    });
    scrollToBottom();
  });

  // ---------- presence ----------
  let onlineUsers = [];
  const dmUnread = new Set(); // peer ids with unread private messages

  function renderUserList() {
    const list = onlineUsers;
    peerCount.textContent = list.length;
    peerCountMobile.textContent = list.length;
    userList.innerHTML = '';
    list.forEach((u) => {
      const li = document.createElement('li');
      const isMe = me && u.id === me.id;
      li.className = 'user-item' + (isMe ? '' : ' user-item-clickable');
      li.title = isMe ? '' : `${u.username} ke saath private chat karein`;
      li.innerHTML = `
        <span class="user-dot" style="color:${u.color}; background:${u.color}"></span>
        <span class="user-name">${escapeHtml(u.username)}</span>
        ${u.sharing ? '<span class="user-sharing" title="Screen share ho raha hai">🖥</span>' : ''}
        ${isMe ? '<span class="user-you">YOU</span>' : (dmUnread.has(u.id) ? '<span class="user-dm-badge" title="Naya private message"></span>' : '')}
      `;
      if (!isMe) li.addEventListener('click', () => openPM(u));
      userList.appendChild(li);
    });

    // update share list (exclude nothing here; screen:started/stopped drive it, this just keeps counts sane)
    if (tttPickScreen && !tttPickScreen.classList.contains('hidden')) renderOpponentList();
  }

  socket.on('users:update', (list) => {
    onlineUsers = list; // keep latest roster around for the Tic-Tac-Toe opponent picker & PM lookups
    renderUserList();
  });

  socket.on('system', (data) => {
    addSystemMessage(data.text);
  });

  // ---------- chat ----------
  function sendMessage() {
    const text = messageInput.value.trim();
    if (!text) return;
    socket.emit('chat:message', { text });
    messageInput.value = '';
    autoGrow();
    stopTyping();
  }
  sendBtn.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  messageInput.addEventListener('input', () => {
    autoGrow();
    socket.emit('chat:typing', { typing: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(stopTyping, 1200);
  });
  function stopTyping() { socket.emit('chat:typing', { typing: false }); }
  function autoGrow() { messageInput.style.height = 'auto'; messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px'; }

  function renderChatMessage(m) {
    const mine = me && m.id === me.id;
    const el = document.createElement('div');
    el.className = 'msg' + (mine ? ' mine' : '');
    el.innerHTML = `
      <div class="msg-meta"><span class="msg-name" style="color:${m.color}">${escapeHtml(m.username)}</span><span>${formatTime(m.time)}</span></div>
      <div class="msg-bubble">${escapeHtml(m.text)}</div>
    `;
    messagesEl.appendChild(el);
  }

  socket.on('chat:message', (m) => {
    renderChatMessage(m);
    scrollToBottom();
  });

  socket.on('chat:typing', ({ id, username, typing }) => {
    if (typing) othersTyping.set(id, username); else othersTyping.delete(id);
    if (othersTyping.size === 0) { typingIndicator.textContent = ''; return; }
    const names = Array.from(othersTyping.values());
    typingIndicator.textContent = names.length === 1
      ? `${names[0]} type kar rahe hain…`
      : `${names.join(', ')} type kar rahe hain…`;
  });

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg-system';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
  }

  // ---------- broadcast ----------
  broadcastBtn.addEventListener('click', () => { broadcastModal.classList.remove('hidden'); broadcastInput.focus(); });
  broadcastCancelBtn.addEventListener('click', () => broadcastModal.classList.add('hidden'));
  broadcastSendBtn.addEventListener('click', () => {
    const text = broadcastInput.value.trim();
    if (!text) return;
    socket.emit('broadcast:send', { text });
    broadcastInput.value = '';
    broadcastModal.classList.add('hidden');
  });

  socket.on('broadcast:receive', (b) => {
    const el = document.createElement('div');
    el.className = 'msg-broadcast';
    el.innerHTML = `
      <div class="msg-meta">📢 BROADCAST — <span class="msg-name" style="color:${b.color}">${escapeHtml(b.username)}</span> · ${formatTime(b.time)}</div>
      <div class="msg-bubble">${escapeHtml(b.text)}</div>
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
    if (navigator.vibrate) navigator.vibrate(80);
  });

  // ---------- file sharing (drag & drop + picker) ----------
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { handleFiles(fileInput.files); fileInput.value = ''; });

  ['dragenter', 'dragover'].forEach(ev => dropZone.addEventListener(ev, (e) => {
    e.preventDefault(); dropZone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === 'drop') handleFiles(e.dataTransfer.files);
    if (ev === 'dragleave' && e.target !== dropZone) return;
    dropZone.classList.remove('dragging');
  }));

  const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB soft cap over LAN socket transport
  function handleFiles(fileList) {
    Array.from(fileList).forEach((file) => {
      if (file.size > MAX_FILE_SIZE) {
        addSystemMessage(`⚠️ "${file.name}" bahut badi hai (max 100MB)`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        socket.emit('file:send', { name: file.name, size: file.size, type: file.type, data: reader.result });
      };
      reader.readAsDataURL(file);
    });
  }

  socket.on('file:receive', (f) => {
    const mine = me && f.id === me.id;
    const el = document.createElement('div');
    el.className = 'msg' + (mine ? ' mine' : '');
    const isImage = f.type && f.type.startsWith('image/');
    el.innerHTML = `
      <div class="msg-meta"><span class="msg-name" style="color:${f.color}">${escapeHtml(f.username)}</span><span>${formatTime(f.time)}</span></div>
      <div class="msg-file">
        <div class="msg-file-icon">${fileIcon(f.type)}</div>
        <div class="msg-file-info">
          <div class="msg-file-name">${escapeHtml(f.name)}</div>
          <div class="msg-file-size">${formatSize(f.size)}</div>
        </div>
        <a class="msg-file-dl" href="${f.data}" download="${escapeAttr(f.name)}">Download</a>
      </div>
      ${isImage ? `<img class="msg-file-img" src="${f.data}" alt="${escapeAttr(f.name)}">` : ''}
    `;
    messagesEl.appendChild(el);
    scrollToBottom();
  });

  function fileIcon(type) {
    if (!type) return '📄';
    if (type.startsWith('image/')) return '🖼';
    if (type.startsWith('video/')) return '🎬';
    if (type.startsWith('audio/')) return '🎵';
    if (type.includes('pdf')) return '📕';
    if (type.includes('zip') || type.includes('compressed')) return '🗜';
    return '📄';
  }
  function formatSize(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  // ---------- private (1-to-1) chat ----------
  const dmThreads = new Map(); // peerId -> [{ from, to, text|name/size/type/data, time, kind }]
  let currentPmPeer = null;

  function openPM(peer) {
    currentPmPeer = peer.id;
    pmHeadName.textContent = peer.username;
    pmHeadDot.style.color = peer.color;
    pmHeadDot.style.background = peer.color;
    dmUnread.delete(peer.id);
    renderUserList();
    renderPmThread(peer.id);
    pmPanel.classList.remove('hidden');
    pmMessageInput.focus();
  }
  function closePM() {
    pmPanel.classList.add('hidden');
    currentPmPeer = null;
    pmTypingIndicator.textContent = '';
  }
  pmCloseBtn.addEventListener('click', closePM);

  function renderPmThread(peerId) {
    pmMessages.innerHTML = '';
    const list = dmThreads.get(peerId) || [];
    if (!list.length) {
      pmMessages.innerHTML = '<div class="pm-empty">Koi message nahi hai — Hi bol kar shuru karein 👋</div>';
      return;
    }
    list.forEach((m) => renderPmMessage(m));
    pmMessages.scrollTop = pmMessages.scrollHeight;
  }

  function renderPmMessage(m) {
    const mine = me && m.from === me.id;
    const el = document.createElement('div');
    el.className = 'msg' + (mine ? ' mine' : '');
    const label = mine ? 'Aap' : m.fromUsername;
    if (m.kind === 'file') {
      const isImage = m.type && m.type.startsWith('image/');
      el.innerHTML = `
        <div class="msg-meta"><span class="msg-name" style="color:${m.fromColor}">${escapeHtml(label)}</span><span>${formatTime(m.time)}</span></div>
        <div class="msg-file">
          <div class="msg-file-icon">${fileIcon(m.type)}</div>
          <div class="msg-file-info">
            <div class="msg-file-name">${escapeHtml(m.name)}</div>
            <div class="msg-file-size">${formatSize(m.size)}</div>
          </div>
          <a class="msg-file-dl" href="${m.data}" download="${escapeAttr(m.name)}">Download</a>
        </div>
        ${isImage ? `<img class="msg-file-img" src="${m.data}" alt="${escapeAttr(m.name)}">` : ''}
      `;
    } else {
      el.innerHTML = `
        <div class="msg-meta"><span class="msg-name" style="color:${m.fromColor}">${escapeHtml(label)}</span><span>${formatTime(m.time)}</span></div>
        <div class="msg-bubble">${escapeHtml(m.text)}</div>
      `;
    }
    pmMessages.appendChild(el);
  }

  function addToThread(peerId, msg) {
    if (!dmThreads.has(peerId)) dmThreads.set(peerId, []);
    dmThreads.get(peerId).push(msg);
  }

  function pmPeerIdFor(m) {
    return (me && m.from === me.id) ? m.to : m.from;
  }

  socket.on('pm:message', (m) => {
    const peerId = pmPeerIdFor(m);
    const entry = { ...m, kind: 'text' };
    addToThread(peerId, entry);
    if (currentPmPeer === peerId) {
      renderPmMessage(entry);
      pmMessages.scrollTop = pmMessages.scrollHeight;
    } else if (!(me && m.from === me.id)) {
      dmUnread.add(peerId);
      renderUserList();
      if (navigator.vibrate) navigator.vibrate(50);
    }
  });

  socket.on('pm:file', (m) => {
    const peerId = pmPeerIdFor(m);
    const entry = { ...m, kind: 'file' };
    addToThread(peerId, entry);
    if (currentPmPeer === peerId) {
      renderPmMessage(entry);
      pmMessages.scrollTop = pmMessages.scrollHeight;
    } else if (!(me && m.from === me.id)) {
      dmUnread.add(peerId);
      renderUserList();
    }
  });

  socket.on('pm:typing', ({ from, username, typing }) => {
    if (currentPmPeer !== from) return;
    pmTypingIndicator.textContent = typing ? `${username} type kar rahe hain…` : '';
  });

  function autoGrowPm() {
    pmMessageInput.style.height = 'auto';
    pmMessageInput.style.height = Math.min(pmMessageInput.scrollHeight, 120) + 'px';
  }
  function sendPm() {
    const text = pmMessageInput.value.trim();
    if (!text || !currentPmPeer) return;
    socket.emit('pm:message', { to: currentPmPeer, text });
    pmMessageInput.value = '';
    autoGrowPm();
    socket.emit('pm:typing', { to: currentPmPeer, typing: false });
  }
  pmSendBtn.addEventListener('click', sendPm);
  pmMessageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPm(); }
  });
  let pmTypingTimeout = null;
  pmMessageInput.addEventListener('input', () => {
    autoGrowPm();
    if (!currentPmPeer) return;
    socket.emit('pm:typing', { to: currentPmPeer, typing: true });
    clearTimeout(pmTypingTimeout);
    pmTypingTimeout = setTimeout(() => socket.emit('pm:typing', { to: currentPmPeer, typing: false }), 1200);
  });

  pmAttachBtn.addEventListener('click', () => pmFileInput.click());
  pmFileInput.addEventListener('change', () => { handlePmFiles(pmFileInput.files); pmFileInput.value = ''; });
  function handlePmFiles(fileList) {
    if (!currentPmPeer) return;
    Array.from(fileList).forEach((file) => {
      if (file.size > MAX_FILE_SIZE) {
        addSystemMessage(`⚠️ "${file.name}" bahut badi hai (max 100MB)`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        socket.emit('pm:file', { to: currentPmPeer, name: file.name, size: file.size, type: file.type, data: reader.result });
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------- screen sharing ----------
  shareScreenBtn.addEventListener('click', async () => {
    if (sharing) { stopSharing(); return; }
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      addSystemMessage('⚠️ Screen share cancel ho gaya ya allow nahi kiya gaya');
      return;
    }
    sharing = true;
    shareScreenBtn.textContent = '⏹ Screen share band karein';
    shareScreenBtn.classList.add('active');
    localStream.getVideoTracks()[0].addEventListener('ended', stopSharing);
    socket.emit('screen:start');
  });

  function stopSharing() {
    if (!sharing) return;
    sharing = false;
    shareScreenBtn.textContent = '🖥 Apni screen share karein';
    shareScreenBtn.classList.remove('active');
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    sharerConnections.forEach(pc => pc.close());
    sharerConnections.clear();
    socket.emit('screen:stop');
  }

  socket.on('screen:started', ({ id, username }) => {
    if (document.getElementById('share-' + id)) return;
    const li = document.createElement('li');
    li.className = 'share-item';
    li.id = 'share-' + id;
    const isMe = me && id === me.id;
    li.innerHTML = `<span>🖥 ${escapeHtml(username)}${isMe ? ' (aap)' : ''}</span>` +
      (isMe ? '' : `<button data-id="${id}">Watch</button>`);
    shareList.appendChild(li);
    if (!isMe) {
      addSystemMessage(`${username} ne screen share shuru kiya`);
      li.querySelector('button').addEventListener('click', () => watchScreen(id, username));
    }
  });

  socket.on('screen:stopped', ({ id }) => {
    const li = document.getElementById('share-' + id);
    if (li) li.remove();
    const pc = viewerConnections.get(id);
    if (pc) { pc.close(); viewerConnections.delete(id); }
    if (!viewerModal.classList.contains('hidden') && viewerModal.dataset.sharer === id) {
      closeViewer();
      addSystemMessage('Screen share khatam ho gaya');
    }
  });

  function watchScreen(sharerId, username) {
    viewerTitle.textContent = `${username} ki screen (live)`;
    viewerModal.dataset.sharer = sharerId;
    viewerModal.classList.remove('hidden');
    socket.emit('screen:watch', { sharerId });
  }
  closeViewerBtn.addEventListener('click', closeViewer);
  function closeViewer() {
    viewerModal.classList.add('hidden');
    viewerVideo.srcObject = null;
    const sharerId = viewerModal.dataset.sharer;
    const pc = viewerConnections.get(sharerId);
    if (pc) { pc.close(); viewerConnections.delete(sharerId); }
  }

  // sharer receives a watch request -> create offer for that viewer
  socket.on('screen:watch-request', async ({ viewerId }) => {
    if (!sharing || !localStream) return;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    sharerConnections.set(viewerId, pc);
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice', { to: viewerId, candidate: e.candidate }); };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc:offer', { to: viewerId, offer });
  });

  // viewer receives offer -> answer it
  socket.on('webrtc:offer', async ({ from, offer }) => {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    viewerConnections.set(from, pc);
    pc.ontrack = (e) => { viewerVideo.srcObject = e.streams[0]; };
    pc.onicecandidate = (e) => { if (e.candidate) socket.emit('webrtc:ice', { to: from, candidate: e.candidate }); };
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    flushCandidates(from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc:answer', { to: from, answer });
  });

  // sharer receives answer
  socket.on('webrtc:answer', async ({ from, answer }) => {
    const pc = sharerConnections.get(from);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
    flushCandidates(from, pc);
  });

  socket.on('webrtc:ice', async ({ from, candidate }) => {
    const pc = sharerConnections.get(from) || viewerConnections.get(from);
    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try { await pc.addIceCandidate(candidate); } catch (e) { /* ignore */ }
    } else {
      if (!pendingCandidates.has(from)) pendingCandidates.set(from, []);
      pendingCandidates.get(from).push(candidate);
    }
  });

  async function flushCandidates(peerId, pc) {
    const queued = pendingCandidates.get(peerId);
    if (!queued) return;
    for (const c of queued) { try { await pc.addIceCandidate(c); } catch (e) { /* ignore */ } }
    pendingCandidates.delete(peerId);
  }

  // ---------- sidebar (mobile) ----------
  menuBtn.addEventListener('click', () => { sidebar.classList.add('open'); sidebarOverlay.classList.add('open'); });
  sidebarOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('open'); });

  // ---------- theme ----------
  themeBtn.addEventListener('click', () => {
    document.body.classList.toggle('light');
    themeBtn.textContent = document.body.classList.contains('light') ? '☀️' : '🌙';
  });

  // ================= GAMES (hub + Tic-Tac-Toe + Snake + Memory Match) =================
  const tttBtn = $('tttBtn'), tttPanel = $('tttPanel'), tttMinBtn = $('tttMinBtn'), tttCloseBtn = $('tttCloseBtn');
  const tttHeadTitle = $('tttHeadTitle');
  const gamesHubScreen = $('gamesHubScreen'), hubTttBtn = $('hubTttBtn'), hubSnakeBtn = $('hubSnakeBtn'), hubMemoryBtn = $('hubMemoryBtn');
  const tttModeScreen = $('tttModeScreen'), tttVsComputerBtn = $('tttVsComputerBtn'), tttVsPlayerBtn = $('tttVsPlayerBtn'), tttModeBackBtn = $('tttModeBackBtn');
  const tttPickScreen = $('tttPickScreen'), tttOpponentList = $('tttOpponentList'), tttNoOpponents = $('tttNoOpponents'), tttPickBackBtn = $('tttPickBackBtn');
  const tttWaitScreen = $('tttWaitScreen'), tttWaitName = $('tttWaitName'), tttCancelWaitBtn = $('tttCancelWaitBtn');
  const tttInviteScreen = $('tttInviteScreen'), tttInviteName = $('tttInviteName'), tttAcceptBtn = $('tttAcceptBtn'), tttDeclineBtn = $('tttDeclineBtn');
  const tttGameScreen = $('tttGameScreen'), tttStatus = $('tttStatus'), tttBoardEl = $('tttBoard');
  const tttRematchBtn = $('tttRematchBtn'), tttLeaveBtn = $('tttLeaveBtn');
  const tttBadge = $('tttBadge');
  const tttCells = Array.from(tttBoardEl.querySelectorAll('.ttt-cell'));
  const snakeScreen = $('snakeScreen'), snakeBackBtn = $('snakeBackBtn');
  const memoryScreen = $('memoryScreen'), memoryBackBtn = $('memoryBackBtn');

  const ALL_GAME_SCREENS = [gamesHubScreen, tttModeScreen, tttPickScreen, tttWaitScreen, tttInviteScreen, tttGameScreen, snakeScreen, memoryScreen];

  let tttMode = null;          // 'computer' | 'player'
  let tttGameId = null;        // server-side game id (player mode only)
  let tttMySymbol = 'X';
  let tttPendingGameId = null; // game we've been invited to / are waiting on
  let tttState = null;         // last known {board, turn, status, winner, line}
  let tttBadgeCount = 0;

  function tttShowScreen(el) {
    ALL_GAME_SCREENS.forEach(s => s.classList.add('hidden'));
    el.classList.remove('hidden');
  }
  function tttOpenPanel() {
    tttPanel.classList.remove('hidden');
    tttPanel.classList.remove('minimized');
    tttBadge.classList.add('hidden');
    tttBadgeCount = 0;
  }
  function tttClosePanel() { tttPanel.classList.add('hidden'); }
  function tttBackToModeSelect() {
    tttMode = null; tttGameId = null; tttPendingGameId = null; tttState = null;
    tttHeadTitle.textContent = '🎮 Games';
    snakeStop();
    tttShowScreen(gamesHubScreen);
  }

  tttBtn.addEventListener('click', () => {
    if (tttPanel.classList.contains('hidden') || tttPanel.classList.contains('minimized')) {
      tttOpenPanel();
      if (!snakeScreen.classList.contains('hidden')) snakeResume();
    } else {
      tttPanel.classList.add('minimized');
      if (!snakeScreen.classList.contains('hidden')) snakePause();
    }
  });
  tttMinBtn.addEventListener('click', () => {
    tttPanel.classList.toggle('minimized');
    if (!snakeScreen.classList.contains('hidden')) {
      if (tttPanel.classList.contains('minimized')) snakePause(); else snakeResume();
    }
  });
  tttCloseBtn.addEventListener('click', () => {
    if (tttGameId) socket.emit('ttt:leave', { gameId: tttGameId });
    tttClosePanel();
    tttBackToModeSelect();
  });
  tttBadge.addEventListener('click', tttOpenPanel);

  // ---- games hub ----
  hubTttBtn.addEventListener('click', () => {
    tttHeadTitle.textContent = '❌⭕ Tic-Tac-Toe';
    tttShowScreen(tttModeScreen);
  });
  hubSnakeBtn.addEventListener('click', () => {
    tttHeadTitle.textContent = '🐍 Snake';
    tttShowScreen(snakeScreen);
    snakeInit();
  });
  hubMemoryBtn.addEventListener('click', () => {
    tttHeadTitle.textContent = '🧠 Memory Match';
    tttShowScreen(memoryScreen);
    memoryInit();
  });
  tttModeBackBtn.addEventListener('click', () => {
    tttHeadTitle.textContent = '🎮 Games';
    tttShowScreen(gamesHubScreen);
  });
  snakeBackBtn.addEventListener('click', () => {
    snakeStop();
    tttHeadTitle.textContent = '🎮 Games';
    tttShowScreen(gamesHubScreen);
  });
  memoryBackBtn.addEventListener('click', () => {
    tttHeadTitle.textContent = '🎮 Games';
    tttShowScreen(gamesHubScreen);
  });

  // ---- mode select ----
  tttVsComputerBtn.addEventListener('click', () => {
    tttMode = 'computer';
    tttMySymbol = 'X';
    tttState = { board: Array(9).fill(null), turn: 'X', status: 'active', winner: null, line: null };
    tttRematchBtn.classList.add('hidden');
    tttRenderBoard('Aapki baari — aap X hain, computer O hai.');
    tttShowScreen(tttGameScreen);
  });

  tttVsPlayerBtn.addEventListener('click', () => {
    renderOpponentList();
    tttShowScreen(tttPickScreen);
  });
  tttPickBackBtn.addEventListener('click', () => tttShowScreen(tttModeScreen));

  function renderOpponentList() {
    const others = onlineUsers.filter(u => !me || u.id !== me.id);
    tttOpponentList.innerHTML = '';
    tttNoOpponents.classList.toggle('hidden', others.length > 0);
    others.forEach(u => {
      const li = document.createElement('li');
      li.className = 'ttt-opponent-item';
      li.innerHTML = `<span>${escapeHtml(u.username)}</span><button data-id="${u.id}">Challenge</button>`;
      li.querySelector('button').addEventListener('click', () => {
        socket.emit('ttt:challenge', { opponentId: u.id });
      });
      tttOpponentList.appendChild(li);
    });
  }

  socket.on('ttt:invite-sent', ({ gameId, opponent }) => {
    tttPendingGameId = gameId;
    tttWaitName.textContent = opponent.username;
    tttShowScreen(tttWaitScreen);
  });
  tttCancelWaitBtn.addEventListener('click', () => {
    if (tttPendingGameId) socket.emit('ttt:leave', { gameId: tttPendingGameId });
    tttPendingGameId = null;
    tttShowScreen(tttModeScreen);
  });

  socket.on('ttt:invite', ({ gameId, from }) => {
    tttPendingGameId = gameId;
    tttInviteName.textContent = from.username;
    tttHeadTitle.textContent = '❌⭕ Tic-Tac-Toe';
    tttOpenPanel();
    tttShowScreen(tttInviteScreen);
    if (navigator.vibrate) navigator.vibrate(60);
    if (tttPanel.classList.contains('hidden')) {
      tttBadgeCount++;
      tttBadge.textContent = `🎮 ${tttBadgeCount}`;
      tttBadge.classList.remove('hidden');
    }
  });
  tttAcceptBtn.addEventListener('click', () => {
    socket.emit('ttt:respond', { gameId: tttPendingGameId, accept: true });
  });
  tttDeclineBtn.addEventListener('click', () => {
    socket.emit('ttt:respond', { gameId: tttPendingGameId, accept: false });
    tttPendingGameId = null;
    tttShowScreen(tttModeScreen);
  });
  socket.on('ttt:declined', () => {
    tttPendingGameId = null;
    tttShowScreen(tttModeScreen);
    addSystemMessage('Aapka Tic-Tac-Toe challenge decline kar diya gaya.');
  });

  socket.on('ttt:start', (state) => {
    tttMode = 'player';
    tttGameId = state.gameId;
    tttPendingGameId = null;
    tttMySymbol = (me && state.players.X.id === me.id) ? 'X' : 'O';
    tttState = state;
    tttOpenPanel();
    tttRenderBoard();
    tttShowScreen(tttGameScreen);
  });

  socket.on('ttt:update', (state) => {
    if (state.gameId !== tttGameId) return;
    tttState = state;
    tttRenderBoard();
  });

  socket.on('ttt:opponent-left', ({ gameId }) => {
    if (gameId !== tttGameId && gameId !== tttPendingGameId) return;
    addSystemMessage('Aapka Tic-Tac-Toe opponent chala gaya / disconnect ho gaya.');
    tttGameId = null; tttPendingGameId = null; tttState = null;
    tttShowScreen(tttModeScreen);
  });

  // ---- board rendering (shared by computer + player mode) ----
  function tttRenderBoard(overrideStatusText) {
    const st = tttState;
    tttCells.forEach((cell, i) => {
      const v = st.board[i];
      cell.textContent = v || '';
      cell.className = 'ttt-cell' + (v === 'X' ? ' x' : v === 'O' ? ' o' : '');
      if (st.line && st.line.includes(i)) cell.classList.add('win');
      const canPlay = st.status === 'active' && !v && st.turn === tttMySymbol;
      cell.disabled = !canPlay;
    });

    if (overrideStatusText) { tttStatus.textContent = overrideStatusText; }
    else if (st.status === 'won') {
      tttStatus.textContent = st.winner === tttMySymbol ? '🎉 Aap jeet gaye!' : (tttMode === 'computer' ? '🤖 Computer jeet gaya.' : `${tttOpponentUsername()} jeet gaye.`);
    } else if (st.status === 'draw') {
      tttStatus.textContent = '🤝 Match draw ho gaya.';
    } else {
      tttStatus.textContent = st.turn === tttMySymbol ? 'Aapki baari…' : (tttMode === 'computer' ? 'Computer soch raha hai…' : `${tttOpponentUsername()} ki baari…`);
    }
    tttRematchBtn.classList.toggle('hidden', st.status === 'active');
  }
  function tttOpponentUsername() {
    if (!tttState || !tttState.players) return 'Opponent';
    const other = tttState.players.X.id === (me && me.id) ? tttState.players.O : tttState.players.X;
    return other.username;
  }

  tttCells.forEach((cell, i) => {
    cell.addEventListener('click', () => {
      if (cell.disabled) return;
      if (tttMode === 'player') {
        socket.emit('ttt:move', { gameId: tttGameId, index: i });
      } else if (tttMode === 'computer') {
        tttComputerPlayerMove(i);
      }
    });
  });

  tttRematchBtn.addEventListener('click', () => {
    if (tttMode === 'player' && tttGameId) {
      socket.emit('ttt:rematch', { gameId: tttGameId });
    } else if (tttMode === 'computer') {
      tttState = { board: Array(9).fill(null), turn: 'X', status: 'active', winner: null, line: null };
      tttRenderBoard('Aapki baari — aap X hain, computer O hai.');
    }
  });

  tttLeaveBtn.addEventListener('click', () => {
    if (tttMode === 'player' && tttGameId) socket.emit('ttt:leave', { gameId: tttGameId });
    tttGameId = null; tttState = null;
    tttShowScreen(tttModeScreen);
  });

  // ---- local "vs Computer" mode: board + simple AI, no server round-trip ----
  const TTT_WIN_LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  function tttEvalWinner(board) {
    for (const line of TTT_WIN_LINES) {
      const [a, b, c] = line;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) return { winner: board[a], line };
    }
    if (board.every(c => c)) return { winner: 'draw', line: null };
    return null;
  }
  function tttComputerPlayerMove(i) {
    if (tttState.status !== 'active' || tttState.board[i] || tttState.turn !== 'X') return;
    tttState.board[i] = 'X';
    let res = tttEvalWinner(tttState.board);
    if (res) { tttState.status = res.winner === 'draw' ? 'draw' : 'won'; tttState.winner = res.winner === 'draw' ? null : res.winner; tttState.line = res.line; tttRenderBoard(); return; }
    tttState.turn = 'O';
    tttRenderBoard();
    setTimeout(() => {
      const move = tttPickComputerMove(tttState.board);
      if (move === -1) return;
      tttState.board[move] = 'O';
      res = tttEvalWinner(tttState.board);
      if (res) { tttState.status = res.winner === 'draw' ? 'draw' : 'won'; tttState.winner = res.winner === 'draw' ? null : res.winner; tttState.line = res.line; }
      else { tttState.turn = 'X'; }
      tttRenderBoard();
    }, 450);
  }
  // decent (not unbeatable) heuristic AI: win > block > center > corner > random
  function tttPickComputerMove(board) {
    const empty = board.map((v, i) => v ? -1 : i).filter(i => i !== -1);
    if (empty.length === 0) return -1;
    const tryFind = (symbol) => {
      for (const i of empty) {
        const copy = board.slice(); copy[i] = symbol;
        if (tttEvalWinner(copy) && tttEvalWinner(copy).winner === symbol) return i;
      }
      return -1;
    };
    let m = tryFind('O'); if (m !== -1) return m;       // win if possible
    m = tryFind('X'); if (m !== -1) return m;           // block player's win
    if (!board[4]) return 4;                            // take center
    const corners = [0, 2, 6, 8].filter(i => !board[i]);
    if (corners.length) return corners[Math.floor(Math.random() * corners.length)];
    return empty[Math.floor(Math.random() * empty.length)];
  }

  // ================= /TIC-TAC-TOE =================

  // ================= SNAKE =================
  const snakeScoreEl = $('snakeScore'), snakeBestEl = $('snakeBest'), snakeOverMsg = $('snakeOverMsg');
  const snakeCanvas = $('snakeCanvas'), snakeRestartBtn = $('snakeRestartBtn');
  const snakeCtx = snakeCanvas.getContext('2d');
  const SNAKE_CELL = 14, SNAKE_COLS = Math.floor(snakeCanvas.width / SNAKE_CELL), SNAKE_ROWS = Math.floor(snakeCanvas.height / SNAKE_CELL);
  const SNAKE_BEST_KEY = 'lanchat_snake_best';

  let snakeBody = [], snakeDir = { x: 1, y: 0 }, snakeNextDir = { x: 1, y: 0 };
  let snakeFood = { x: 5, y: 5 }, snakeScore = 0, snakeAlive = false, snakeTimer = null, snakeSpeed = 190;

  function snakeCssVar(name) { return getComputedStyle(document.body).getPropertyValue(name).trim(); }

  function snakeInit() {
    snakeStop();
    snakeBody = [{ x: 6, y: 8 }, { x: 5, y: 8 }, { x: 4, y: 8 }];
    snakeDir = { x: 1, y: 0 };
    snakeNextDir = { x: 1, y: 0 };
    snakeScore = 0;
    snakeSpeed = 190;
    snakeAlive = true;
    snakeOverMsg.classList.add('hidden');
    snakeScoreEl.textContent = '0';
    snakeBestEl.textContent = localStorage.getItem(SNAKE_BEST_KEY) || '0';
    snakePlaceFood();
    snakeDraw();
    snakeTimer = setInterval(snakeTick, snakeSpeed);
  }
  function snakeStop() { if (snakeTimer) { clearInterval(snakeTimer); snakeTimer = null; } snakeAlive = false; }
  function snakePause() { if (snakeTimer) { clearInterval(snakeTimer); snakeTimer = null; } } // keeps state, just halts the loop
  function snakeResume() { if (snakeAlive && !snakeTimer) snakeTimer = setInterval(snakeTick, snakeSpeed); }

  function snakePlaceFood() {
    let pos;
    do {
      pos = { x: Math.floor(Math.random() * SNAKE_COLS), y: Math.floor(Math.random() * SNAKE_ROWS) };
    } while (snakeBody.some(s => s.x === pos.x && s.y === pos.y));
    snakeFood = pos;
  }

  function snakeSetDir(dx, dy) {
    // can't reverse directly into yourself
    if (snakeBody.length > 1 && dx === -snakeDir.x && dy === -snakeDir.y) return;
    snakeNextDir = { x: dx, y: dy };
  }

  function snakeTick() {
    if (!snakeAlive) return;
    snakeDir = snakeNextDir;
    const head = { x: snakeBody[0].x + snakeDir.x, y: snakeBody[0].y + snakeDir.y };

    const hitWall = head.x < 0 || head.y < 0 || head.x >= SNAKE_COLS || head.y >= SNAKE_ROWS;
    const hitSelf = snakeBody.some(s => s.x === head.x && s.y === head.y);
    if (hitWall || hitSelf) { snakeGameOver(); return; }

    snakeBody.unshift(head);
    if (head.x === snakeFood.x && head.y === snakeFood.y) {
      snakeScore++;
      snakeScoreEl.textContent = snakeScore;
      snakePlaceFood();
      if (snakeScore % 5 === 0 && snakeSpeed > 110) {
        snakeSpeed -= 8;
        clearInterval(snakeTimer);
        snakeTimer = setInterval(snakeTick, snakeSpeed);
      }
    } else {
      snakeBody.pop();
    }
    snakeDraw();
  }

  function snakeGameOver() {
    snakeAlive = false;
    clearInterval(snakeTimer); snakeTimer = null;
    snakeOverMsg.classList.remove('hidden');
    const best = parseInt(localStorage.getItem(SNAKE_BEST_KEY) || '0', 10);
    if (snakeScore > best) { localStorage.setItem(SNAKE_BEST_KEY, String(snakeScore)); snakeBestEl.textContent = snakeScore; }
  }

  function snakeDraw() {
    const bg = snakeCssVar('--panel-2') || '#1c222c';
    const green = snakeCssVar('--green') || '#3ddc97';
    const amber = snakeCssVar('--amber') || '#ffb454';
    const border = snakeCssVar('--border') || '#262d3a';
    snakeCtx.fillStyle = bg;
    snakeCtx.fillRect(0, 0, snakeCanvas.width, snakeCanvas.height);
    // subtle grid
    snakeCtx.strokeStyle = border;
    snakeCtx.lineWidth = 0.5;
    for (let x = 0; x <= SNAKE_COLS; x++) { snakeCtx.beginPath(); snakeCtx.moveTo(x * SNAKE_CELL, 0); snakeCtx.lineTo(x * SNAKE_CELL, snakeCanvas.height); snakeCtx.stroke(); }
    for (let y = 0; y <= SNAKE_ROWS; y++) { snakeCtx.beginPath(); snakeCtx.moveTo(0, y * SNAKE_CELL); snakeCtx.lineTo(snakeCanvas.width, y * SNAKE_CELL); snakeCtx.stroke(); }
    // food
    snakeCtx.fillStyle = amber;
    snakeCtx.fillRect(snakeFood.x * SNAKE_CELL + 2, snakeFood.y * SNAKE_CELL + 2, SNAKE_CELL - 4, SNAKE_CELL - 4);
    // snake
    snakeBody.forEach((seg, i) => {
      snakeCtx.fillStyle = green;
      snakeCtx.globalAlpha = i === 0 ? 1 : 0.85;
      snakeCtx.fillRect(seg.x * SNAKE_CELL + 1, seg.y * SNAKE_CELL + 1, SNAKE_CELL - 2, SNAKE_CELL - 2);
    });
    snakeCtx.globalAlpha = 1;
  }

  snakeRestartBtn.addEventListener('click', snakeInit);
  document.querySelectorAll('.snake-pad-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;
      if (dir === 'up') snakeSetDir(0, -1);
      else if (dir === 'down') snakeSetDir(0, 1);
      else if (dir === 'left') snakeSetDir(-1, 0);
      else if (dir === 'right') snakeSetDir(1, 0);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (snakeScreen.classList.contains('hidden')) return; // only capture keys while Snake is open
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // don't hijack chat typing
    const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0] };
    if (map[e.key]) { e.preventDefault(); snakeSetDir(map[e.key][0], map[e.key][1]); }
  });
  // ================= /SNAKE =================

  // ================= MEMORY MATCH =================
  const memoryGrid = $('memoryGrid'), memoryMoves = $('memoryMoves'), memoryPairs = $('memoryPairs');
  const memoryWinMsg = $('memoryWinMsg'), memoryRestartBtn = $('memoryRestartBtn');
  const MEMORY_EMOJIS = ['🐱','🐶','🦊','🐼','🐸','🦁','🐵','🐷','🐰','🐨','🐯','🐮'];

  let memoryCards = [], memoryFlipped = [], memoryMatchedCount = 0, memoryMoveCount = 0, memoryLocked = false;

  function memoryInit() {
    const chosen = MEMORY_EMOJIS.slice().sort(() => Math.random() - 0.5).slice(0, 8);
    memoryCards = chosen.concat(chosen).sort(() => Math.random() - 0.5);
    memoryFlipped = [];
    memoryMatchedCount = 0;
    memoryMoveCount = 0;
    memoryLocked = false;
    memoryMoves.textContent = '0';
    memoryPairs.textContent = '0';
    memoryWinMsg.classList.add('hidden');

    memoryGrid.innerHTML = '';
    memoryCards.forEach((emoji, i) => {
      const btn = document.createElement('button');
      btn.className = 'memory-card';
      btn.dataset.index = i;
      btn.textContent = '';
      btn.addEventListener('click', () => memoryFlip(i));
      memoryGrid.appendChild(btn);
    });
  }

  function memoryFlip(i) {
    if (memoryLocked) return;
    const cardEl = memoryGrid.children[i];
    if (cardEl.classList.contains('flipped') || cardEl.classList.contains('matched')) return;
    if (memoryFlipped.length >= 2) return;

    cardEl.classList.add('flipped');
    cardEl.textContent = memoryCards[i];
    memoryFlipped.push(i);

    if (memoryFlipped.length === 2) {
      memoryMoveCount++;
      memoryMoves.textContent = memoryMoveCount;
      const [a, b] = memoryFlipped;
      if (memoryCards[a] === memoryCards[b]) {
        memoryGrid.children[a].classList.add('matched');
        memoryGrid.children[b].classList.add('matched');
        memoryGrid.children[a].disabled = true;
        memoryGrid.children[b].disabled = true;
        memoryFlipped = [];
        memoryMatchedCount++;
        memoryPairs.textContent = memoryMatchedCount;
        if (memoryMatchedCount === 8) memoryWinMsg.classList.remove('hidden');
      } else {
        memoryLocked = true;
        setTimeout(() => {
          memoryGrid.children[a].classList.remove('flipped');
          memoryGrid.children[b].classList.remove('flipped');
          memoryGrid.children[a].textContent = '';
          memoryGrid.children[b].textContent = '';
          memoryFlipped = [];
          memoryLocked = false;
        }, 700);
      }
    }
  }

  memoryRestartBtn.addEventListener('click', memoryInit);
  // ================= /MEMORY MATCH =================

  // ---------- helpers ----------
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('hi-IN', { hour: '2-digit', minute: '2-digit' });
  }
  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

  window.addEventListener('beforeunload', () => { if (sharing) socket.emit('screen:stop'); });
})();
