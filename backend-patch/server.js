const express = require('express');
const http = require('http');
const https = require('https');
const selfsigned = require('selfsigned');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const dns = require('dns');

const app = express();

// Plain HTTP server: chat + files work fine here.
const httpServer = http.createServer(app);

// HTTPS server with an auto-generated self-signed certificate.
// Screen sharing (getDisplayMedia) is a browser API that ONLY works in a
// "secure context" — so on a LAN IP (not localhost) it needs HTTPS.
const pems = selfsigned.generate([{ name: 'commonName', value: 'localhost' }], { days: 3650, keySize: 4096, algorithm: 'sha256' });
const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);

const io = new Server(httpServer, {
  maxHttpBufferSize: 5e8, // 500MB ceiling for file transfers over the socket
  cors: {
    // The Android app's WebView loads from its own origin (capacitor://localhost
    // or https://localhost), not this server's origin — so Socket.IO's CORS
    // check needs to explicitly allow it, alongside plain LAN browser tabs.
    origin: true, // reflect the request's origin — fine for a LAN/private chat tool
    methods: ['GET', 'POST'],
    credentials: true
  }
});
io.attach(httpsServer); // same chat/socket logic works over both servers

const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

app.use(express.static(path.join(__dirname, 'public')));

// ---- In-memory presence state (nothing to persist here) ----
const users = new Map(); // socket.id -> { username, color }
const activeScreenShares = new Set(); // socket ids currently sharing
let messageCounter = 0;

// ---- Chat persistence: saved to disk as a gzip-compressed JSON file ----
// (files ka raw data yaha store nahi hota — sirf naam/size/type, taaki file
//  chhoti rahe. Chat text/system messages poore save hote hain.)
const DATA_DIR = path.join(__dirname, 'data');
const CHAT_LOG_FILE = path.join(DATA_DIR, 'chat-log.json.gz');
const MAX_HISTORY = 2000; // purane messages trim ho jate hain isse zyada

let chatHistory = [];

function loadChatHistory() {
  try {
    if (fs.existsSync(CHAT_LOG_FILE)) {
      const compressed = fs.readFileSync(CHAT_LOG_FILE);
      const json = zlib.gunzipSync(compressed).toString('utf8');
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) chatHistory = parsed;
      console.log(`Loaded ${chatHistory.length} messages from ${path.basename(CHAT_LOG_FILE)}`);
    }
  } catch (err) {
    console.error('Could not load chat history (starting fresh):', err.message);
    chatHistory = [];
  }
}
loadChatHistory();

// Debounced + gzip-compressed write, so disk isn't hit on every single message
let saveTimer = null;
function persistChatHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const json = JSON.stringify(chatHistory);
      const compressed = zlib.gzipSync(json);
      fs.writeFileSync(CHAT_LOG_FILE, compressed);
    } catch (err) {
      console.error('Could not save chat history:', err.message);
    }
  }, 400);
}

function logToHistory(entry) {
  chatHistory.push(entry);
  if (chatHistory.length > MAX_HISTORY) chatHistory = chatHistory.slice(-MAX_HISTORY);
  persistChatHistory();
}

// ---- Tic-Tac-Toe: in-memory games (multiplayer, 1v1, group ke andar) ----
const tttGames = new Map(); // gameId -> { players:{X:id,O:id}, board:[...], turn, status, winner, line }
let tttCounter = 0;

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8], // rows
  [0,3,6],[1,4,7],[2,5,8], // cols
  [0,4,8],[2,4,6]          // diagonals
];
function tttCheckWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line };
    }
  }
  if (board.every(c => c)) return { winner: 'draw', line: null };
  return null;
}
function tttOpponentId(game, id) {
  return game.players.X === id ? game.players.O : game.players.X;
}
function tttSymbolFor(game, id) {
  return game.players.X === id ? 'X' : 'O';
}
function tttPublicState(game) {
  const px = users.get(game.players.X);
  const po = users.get(game.players.O);
  return {
    gameId: game.id,
    board: game.board,
    turn: game.turn,
    status: game.status, // 'active' | 'won' | 'draw'
    winner: game.winner,
    line: game.line,
    players: {
      X: { id: game.players.X, username: px ? px.username : '???' },
      O: { id: game.players.O, username: po ? po.username : '???' }
    }
  };
}
// remove any game(s) a disconnecting/leaving socket is part of, notify the other player
function tttCleanupForSocket(socketId) {
  for (const [gameId, game] of tttGames.entries()) {
    if (game.players.X === socketId || game.players.O === socketId) {
      const otherId = tttOpponentId(game, socketId);
      tttGames.delete(gameId);
      if (otherId) io.to(otherId).emit('ttt:opponent-left', { gameId });
    }
  }
}

const NODE_COLORS = [
  '#3ddc97', '#4fb0ff', '#ffb454', '#ff6b9d',
  '#a78bfa', '#5eead4', '#f472b6', '#fbbf24'
];
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return NODE_COLORS[hash % NODE_COLORS.length];
}

function broadcastUserList() {
  const list = Array.from(users.entries()).map(([id, u]) => ({
    id, username: u.username, color: u.color, sharing: activeScreenShares.has(id)
  }));
  io.emit('users:update', list);
}

function systemMessage(text) {
  const entry = { type: 'system', text, time: Date.now() };
  logToHistory(entry);
  io.emit('system', { text: entry.text, time: entry.time });
}

// ---- Auto-detect a device's name from the network (best-effort) ----
// Browsers don't expose the real OS username to a webpage for privacy reasons,
// so this is the closest practical substitute:
//  1. If someone opens the page on the SAME machine that's running this server
//     (via localhost/127.0.0.1 or the server's own LAN IP), we use the real
//     OS computer name (os.hostname()) — this is always accurate.
//  2. Otherwise we try a reverse-DNS (PTR) lookup of the connecting device's
//     LAN IP. Some routers register each device's hostname for this.
//  3. If that also fails (most consumer routers don't support it), we fall
//     back to a name derived from the device's own LAN IP address (e.g.
//     "PC-1-45"), NOT a random string — so the SAME computer always gets the
//     SAME name every time it connects, instead of a new random name each visit.
const SERVER_LAN_IPS = new Set(getLanIPs());

function ipDeviceLabel(ip) {
  const parts = ip.split('.');
  if (parts.length === 4) return `PC-${parts[2]}-${parts[3]}`; // last two octets: stable per device
  const tail = ip.replace(/[^a-zA-Z0-9]/g, '').slice(-6);
  return `PC-${tail || 'unknown'}`;
}

function guessDeviceName(socket, cb) {
  const ip = (socket.handshake.address || '').replace(/^::ffff:/, '');
  if (!ip || ip === '::1' || ip === '127.0.0.1' || SERVER_LAN_IPS.has(ip)) {
    return cb(os.hostname()); // this is the machine running the server itself
  }
  dns.reverse(ip, (err, hostnames) => {
    if (!err && hostnames && hostnames.length) {
      const name = hostnames[0].split('.')[0].replace(/[_]+/g, ' ').trim();
      if (name) return cb(name);
    }
    cb(ipDeviceLabel(ip)); // deterministic fallback tied to their IP, not random
  });
}

// If two connections resolve to the same name (e.g. two tabs on one PC),
// tell them apart with "(2)", "(3)"... while keeping the recognizable base name.
function uniqueUsername(base) {
  const taken = new Set(Array.from(users.values()).map(u => u.username));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i++;
  return `${base} (${i})`;
}

io.on('connection', (socket) => {
  socket.on('join', ({ username } = {}) => {
    const provided = (username || '').toString().trim().slice(0, 24);

    const finishJoin = (name) => {
      const base = (name || 'Guest').toString().trim().slice(0, 24) || 'Guest';
      const clean = uniqueUsername(base);
      users.set(socket.id, { username: clean, color: colorFor(socket.id) });
      socket.emit('joined', { id: socket.id, username: clean, color: colorFor(socket.id) });
      // Har join par disk se history dobara load karte hain (sirf startup par nahi) —
      // isse agar server kabhi 2 processes (e.g. pm2 cluster mode) mein chal raha ho,
      // ya beech mein kabhi restart hua ho, tab bhi purana saved chat hamesha sahi
      // (sabse latest) dikhega, purani in-memory copy par depend nahi karna padega.
      loadChatHistory();
      socket.emit('chat:history', chatHistory); // saved (compressed) chat, so far
      systemMessage(`${clean} joined the network`);
      broadcastUserList();
    };

    if (provided) return finishJoin(provided); // client already has a saved/typed name
    guessDeviceName(socket, finishJoin); // no name yet -> detect this device's name
  });

  socket.on('rename', ({ username }) => {
    const u = users.get(socket.id);
    if (!u) return;
    const clean = (username || '').toString().trim().slice(0, 24);
    if (!clean || clean === u.username) return;
    const old = u.username;
    u.username = clean;
    socket.emit('joined', { id: socket.id, username: clean, color: u.color });
    systemMessage(`${old} is now known as ${clean}`);
    broadcastUserList();
  });

  socket.on('chat:message', ({ text }) => {
    const u = users.get(socket.id);
    if (!u || !text || !text.toString().trim()) return;
    messageCounter++;
    const entry = {
      type: 'chat',
      mid: messageCounter,
      id: socket.id,
      username: u.username,
      color: u.color,
      text: text.toString().slice(0, 4000),
      time: Date.now()
    };
    logToHistory(entry);
    io.emit('chat:message', entry);
  });

  socket.on('chat:typing', ({ typing }) => {
    const u = users.get(socket.id);
    if (!u) return;
    socket.broadcast.emit('chat:typing', { id: socket.id, username: u.username, typing: !!typing });
  });

  // ---- File transfer: chunked + acknowledged ----
  // Mobile photos/videos can be several MB, and a single giant socket.emit
  // over a flaky LAN/mobile connection can silently stall with zero feedback
  // to the sender. So the client sends files as a stream of small base64
  // chunks (see file:chunk-*) and gets an ack at each stage — begin/end both
  // call back so the UI can show a real "sent" or "failed" state instead of
  // leaving the person guessing whether it went through.
  const MAX_FILE_BYTES = 100 * 1024 * 1024; // keep in sync with client MAX_FILE_SIZE
  const uploads = new Map(); // uploadId -> { chunks: string[], name, size, type, from }

  socket.on('file-begin', ({ uploadId, name, size, type }, cb) => {
    const u = users.get(socket.id);
    if (!u || !uploadId) return cb && cb({ ok: false, error: 'not-ready' });
    if ((size || 0) > MAX_FILE_BYTES) return cb && cb({ ok: false, error: 'too-large' });
    uploads.set(uploadId, {
      chunks: [],
      name: (name || 'file').toString().slice(0, 200),
      size: size || 0,
      type: type || 'application/octet-stream',
      _owner: socket.id
    });
    cb && cb({ ok: true });
  });

  socket.on('file-chunk', ({ uploadId, index, data }, cb) => {
    const up = uploads.get(uploadId);
    if (!up) return cb && cb({ ok: false, error: 'unknown-upload' });
    up.chunks[index] = data;
    cb && cb({ ok: true });
  });

  socket.on('file-end', ({ uploadId }, cb) => {
    const u = users.get(socket.id);
    const up = uploads.get(uploadId);
    if (!u || !up) return cb && cb({ ok: false, error: 'unknown-upload' });
    uploads.delete(uploadId);
    const base64 = up.chunks.join('');
    if (!base64) return cb && cb({ ok: false, error: 'empty' });
    const dataUrl = `data:${up.type};base64,${base64}`;
    messageCounter++;
    const meta = {
      mid: messageCounter,
      id: socket.id,
      username: u.username,
      color: u.color,
      name: up.name,
      size: up.size,
      type: up.type,
      time: Date.now()
    };
    // Only metadata (name/size/type) goes into the persisted history;
    // raw file bytes are kept out so the saved chat log stays small.
    logToHistory({ type: 'file', ...meta });
    // uploadId is echoed back so the sender's client can swap its local
    // "sending…" placeholder for this exact confirmed message.
    io.emit('file:receive', { ...meta, data: dataUrl, uploadId });
    cb && cb({ ok: true, mid: meta.mid });
  });

  // ---- Backward-compatible single-shot upload for the plain browser client
  // (backend-patch/public/app.js) — that page sends the whole file in one
  // event instead of chunking, so it needs its own handler alongside the
  // chunked file-begin/file-chunk/file-end above.
  socket.on('file:send', ({ name, size, type, data }) => {
    const u = users.get(socket.id);
    if (!u || !data) return;
    messageCounter++;
    const meta = {
      mid: messageCounter,
      id: socket.id,
      username: u.username,
      color: u.color,
      name: (name || 'file').toString().slice(0, 200),
      size: size || 0,
      type: type || 'application/octet-stream',
      time: Date.now()
    };
    logToHistory({ type: 'file', ...meta });
    io.emit('file:receive', { ...meta, data });
  });

  socket.on('broadcast:send', ({ text }) => {
    const u = users.get(socket.id);
    if (!u || !text || !text.toString().trim()) return;
    io.emit('broadcast:receive', {
      id: socket.id,
      username: u.username,
      color: u.color,
      text: text.toString().slice(0, 1000),
      time: Date.now()
    });
  });

  // ---- Private (1-to-1) chat — live only, not written to the disk log ----
  // (socket ids change on every reconnect, so persisting DMs by socket id
  //  would silently break/scramble threads across sessions; kept in-memory.)
  socket.on('pm:message', ({ to, text }) => {
    const u = users.get(socket.id);
    const target = users.get(to);
    if (!u || !target || !text || !text.toString().trim()) return;
    const payload = {
      from: socket.id,
      to,
      fromUsername: u.username,
      fromColor: u.color,
      text: text.toString().slice(0, 4000),
      time: Date.now()
    };
    io.to(to).emit('pm:message', payload);
    socket.emit('pm:message', payload); // echo back so the sender's own thread updates too
  });

  const pmUploads = new Map(); // uploadId -> { chunks, name, size, type, to }

  // Backward-compatible single-shot PM file upload for the plain browser
  // client — sends the whole file in one 'pm:file' event (no chunking).
  socket.on('pm:file', ({ to, name, size, type, data }) => {
    const u = users.get(socket.id);
    const target = users.get(to);
    if (!u || !target || !data) return;
    const payload = {
      from: socket.id,
      to,
      fromUsername: u.username,
      fromColor: u.color,
      name: (name || 'file').toString().slice(0, 200),
      size: size || 0,
      type: type || 'application/octet-stream',
      data,
      time: Date.now()
    };
    io.to(to).emit('pm:file', payload);
    socket.emit('pm:file', payload);
  });

  socket.on('pm:file-begin', ({ uploadId, to, name, size, type }, cb) => {
    const u = users.get(socket.id);
    const target = users.get(to);
    if (!u || !target || !uploadId) return cb && cb({ ok: false, error: 'not-ready' });
    if ((size || 0) > MAX_FILE_BYTES) return cb && cb({ ok: false, error: 'too-large' });
    pmUploads.set(uploadId, {
      chunks: [],
      to,
      name: (name || 'file').toString().slice(0, 200),
      size: size || 0,
      type: type || 'application/octet-stream',
      _owner: socket.id
    });
    cb && cb({ ok: true });
  });

  socket.on('pm:file-chunk', ({ uploadId, index, data }, cb) => {
    const up = pmUploads.get(uploadId);
    if (!up) return cb && cb({ ok: false, error: 'unknown-upload' });
    up.chunks[index] = data;
    cb && cb({ ok: true });
  });

  socket.on('pm:file-end', ({ uploadId }, cb) => {
    const u = users.get(socket.id);
    const up = pmUploads.get(uploadId);
    const target = up && users.get(up.to);
    if (!u || !up || !target) return cb && cb({ ok: false, error: 'unknown-upload' });
    pmUploads.delete(uploadId);
    const base64 = up.chunks.join('');
    if (!base64) return cb && cb({ ok: false, error: 'empty' });
    const payload = {
      from: socket.id,
      to: up.to,
      fromUsername: u.username,
      fromColor: u.color,
      name: up.name,
      size: up.size,
      type: up.type,
      data: `data:${up.type};base64,${base64}`,
      time: Date.now(),
      uploadId
    };
    io.to(up.to).emit('pm:file', payload);
    socket.emit('pm:file', payload);
    cb && cb({ ok: true });
  });

  socket.on('pm:typing', ({ to, typing }) => {
    const u = users.get(socket.id);
    const target = users.get(to);
    if (!u || !target) return;
    io.to(to).emit('pm:typing', { from: socket.id, username: u.username, typing: !!typing });
  });

  // ---- Screen sharing signaling (WebRTC, peer-to-peer over LAN) ----
  socket.on('screen:start', () => {
    activeScreenShares.add(socket.id);
    const u = users.get(socket.id);
    io.emit('screen:started', { id: socket.id, username: u ? u.username : 'Someone' });
    broadcastUserList();
  });

  socket.on('screen:stop', () => {
    activeScreenShares.delete(socket.id);
    io.emit('screen:stopped', { id: socket.id });
    broadcastUserList();
  });

  socket.on('screen:watch', ({ sharerId }) => {
    io.to(sharerId).emit('screen:watch-request', { viewerId: socket.id });
  });

  socket.on('webrtc:offer', ({ to, offer }) => {
    io.to(to).emit('webrtc:offer', { from: socket.id, offer });
  });
  socket.on('webrtc:answer', ({ to, answer }) => {
    io.to(to).emit('webrtc:answer', { from: socket.id, answer });
  });
  socket.on('webrtc:ice', ({ to, candidate }) => {
    io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
  });

  // ---- Tic-Tac-Toe signaling (1v1 multiplayer, played within the group) ----
  socket.on('ttt:challenge', ({ opponentId }) => {
    const challenger = users.get(socket.id);
    const opponent = users.get(opponentId);
    if (!challenger || !opponent || opponentId === socket.id) return;
    tttCounter++;
    const gameId = 'ttt' + tttCounter;
    // stash a pending (not-yet-accepted) game keyed by gameId; board stays empty till accept
    tttGames.set(gameId, {
      id: gameId,
      players: { X: socket.id, O: opponentId },
      board: Array(9).fill(null),
      turn: 'X',
      status: 'pending',
      winner: null,
      line: null
    });
    socket.emit('ttt:invite-sent', { gameId, opponent: { id: opponentId, username: opponent.username } });
    io.to(opponentId).emit('ttt:invite', { gameId, from: { id: socket.id, username: challenger.username } });
  });

  socket.on('ttt:respond', ({ gameId, accept }) => {
    const game = tttGames.get(gameId);
    if (!game || game.status !== 'pending' || game.players.O !== socket.id) return;
    if (!accept) {
      tttGames.delete(gameId);
      io.to(game.players.X).emit('ttt:declined', { gameId });
      return;
    }
    game.status = 'active';
    const state = tttPublicState(game);
    io.to(game.players.X).emit('ttt:start', state);
    io.to(game.players.O).emit('ttt:start', state);
  });

  socket.on('ttt:move', ({ gameId, index }) => {
    const game = tttGames.get(gameId);
    if (!game || game.status !== 'active') return;
    if (typeof index !== 'number' || index < 0 || index > 8) return;
    const symbol = tttSymbolFor(game, socket.id);
    if (game.turn !== symbol) return; // not your turn
    if (game.players.X !== socket.id && game.players.O !== socket.id) return; // not a player in this game
    if (game.board[index]) return; // cell taken

    game.board[index] = symbol;
    const result = tttCheckWinner(game.board);
    if (result) {
      game.status = result.winner === 'draw' ? 'draw' : 'won';
      game.winner = result.winner === 'draw' ? null : result.winner;
      game.line = result.line;
    } else {
      game.turn = symbol === 'X' ? 'O' : 'X';
    }
    const state = tttPublicState(game);
    io.to(game.players.X).emit('ttt:update', state);
    io.to(game.players.O).emit('ttt:update', state);
  });

  socket.on('ttt:rematch', ({ gameId }) => {
    const game = tttGames.get(gameId);
    if (!game || (game.players.X !== socket.id && game.players.O !== socket.id)) return;
    game.board = Array(9).fill(null);
    game.turn = 'X';
    game.status = 'active';
    game.winner = null;
    game.line = null;
    const state = tttPublicState(game);
    io.to(game.players.X).emit('ttt:update', state);
    io.to(game.players.O).emit('ttt:update', state);
  });

  socket.on('ttt:leave', ({ gameId }) => {
    const game = tttGames.get(gameId);
    if (!game) return;
    const otherId = tttOpponentId(game, socket.id);
    tttGames.delete(gameId);
    if (otherId) io.to(otherId).emit('ttt:opponent-left', { gameId });
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    users.delete(socket.id);
    activeScreenShares.delete(socket.id);
    tttCleanupForSocket(socket.id);
    // Drop any in-progress uploads from this socket so they don't leak memory.
    for (const [id, up] of uploads) if (up._owner === socket.id) uploads.delete(id);
    for (const [id, up] of pmUploads) if (up._owner === socket.id) pmUploads.delete(id);
    if (u) {
      systemMessage(`${u.username} left the network`);
      io.emit('screen:stopped', { id: socket.id });
      broadcastUserList();
    }
  });
});

function getLanIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`\nLAN Temporary Chat running.\n`);
  console.log(`Chat & file sharing (HTTP):`);
  console.log(`  Local:   http://localhost:${HTTP_PORT}`);
  getLanIPs().forEach(ip => console.log(`  Network: http://${ip}:${HTTP_PORT}`));
});

httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`\nFull app incl. Screen Share (HTTPS, self-signed cert):`);
  console.log(`  Local:   https://localhost:${HTTPS_PORT}`);
  getLanIPs().forEach(ip => console.log(`  Network: https://${ip}:${HTTPS_PORT}`));
  console.log(`\n  (Browser ek baar security warning dikhayega — "Advanced" > "Proceed`);
  console.log(`   anyway / Continue" par click karke aage badh jayein, cert khud ka bana hai isliye safe hai.)`);
  console.log(`\nScreen share ke liye HTTPS URL hi use karein. Sabhi devices par same URL share karein.\n`);
});
