(() => {
  'use strict';

  const SERVER_KEY = 'lanchat:serverUrl:v1';
  const LOGIN_KEY = 'lanchat:loggedIn:v1';
  const NAME_KEY = 'lanchat:username:v2'; // same key app.js already uses
  const DEFAULT_SERVER = 'https://chat.hamariduniya.in';

  const native = window.LanChatNative || null;
  const isApp = window.__lanchatIsApp === true;

  let appIsActive = true;

  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  function normalizeServerUrl(raw) {
    let v = (raw || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v.replace(/\/+$/, '');
  }

  async function savePrefMirrored(key, value) {
    localStorage.setItem(key, value);
    if (native) { try { await native.Preferences.set({ key, value }); } catch (e) {} }
  }

  async function detectDeviceName() {
    if (native) {
      try {
        const info = await native.Device.getInfo();
        return (info.name || info.model || 'Mobile').toString().slice(0, 24);
      } catch (e) {}
    }
    return '';
  }

  async function requestNotificationPermission() {
    if (!native) return;
    try { await native.LocalNotifications.requestPermissions(); } catch (e) {}
  }

  async function showLocalNotification(title, body) {
    if (!native) return;
    try {
      await native.LocalNotifications.schedule({
        notifications: [{ id: Math.floor(Math.random() * 1000000), title, body: (body || '').slice(0, 180) }]
      });
    } catch (e) {}
  }

  async function startBackgroundService(username) {
    if (!native) return;
    try { await native.BackgroundConnection.start({ text: `${username} — LAN Chat background me connected hai` }); } catch (e) {}
  }
  async function stopBackgroundService() {
    if (!native) return;
    try { await native.BackgroundConnection.stop(); } catch (e) {}
  }

  function buildLoginOverlay() {
    const overlay = el('div', 'lc-login-overlay');
    overlay.innerHTML = `
      <div class="lc-login-card">
        <div class="lc-login-eyebrow">$ lan-chat --mobile</div>
        <h1 class="lc-login-title">LAN Chat</h1>
        <p class="lc-login-sub">Aapka naam is device se dikhega — username/password ki zaroorat nahi.</p>

        <label class="lc-field-label">Aapka naam</label>
        <input id="lcNameInput" class="lc-input" type="text" maxlength="24" placeholder="Naam..." />

        <label class="lc-field-label">Server address</label>
        <input id="lcServerInput" class="lc-input" type="text" placeholder="192.168.1.10:3000 ya https://chat.hamariduniya.in" />
        <p class="lc-field-hint">Office LAN par IP:port daalein, ya internet se connect karne ke liye https://chat.hamariduniya.in (ya apna address).</p>

        <button id="lcLoginBtn" class="lc-btn lc-btn-primary">Login &amp; Connect</button>
        <p id="lcLoginStatus" class="lc-login-status"></p>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function buildSettingsPanel() {
    const panel = el('div', 'lc-settings-panel hidden');
    panel.innerHTML = `
      <div class="lc-settings-card">
        <div class="lc-settings-title">⚙️ Settings</div>
        <label class="lc-field-label">Server address</label>
        <input id="lcSettingsServer" class="lc-input" type="text" />
        <button id="lcReconnectBtn" class="lc-btn lc-btn-primary">Save &amp; Reconnect</button>
        <hr class="lc-divider" />
        <button id="lcLogoutBtn" class="lc-btn lc-btn-danger">Logout</button>
        <button id="lcSettingsCloseBtn" class="lc-btn lc-btn-ghost">Close</button>
      </div>`;
    document.body.appendChild(panel);
    return panel;
  }

  function addPersistentSettingsButton(onClick) {
    if (document.getElementById('lcPersistentGear')) return;
    const btn = el('button', 'lc-persistent-gear', '⚙️');
    btn.id = 'lcPersistentGear';
    btn.title = 'Settings';
    btn.addEventListener('click', onClick);
    document.body.appendChild(btn);
  }

  function addGearButton() {
    const statusbarRight = document.querySelector('.statusbar-right');
    if (!statusbarRight || document.getElementById('lcGearBtn')) return document.getElementById('lcGearBtn');
    const btn = el('button', 'chip', '⚙️');
    btn.id = 'lcGearBtn';
    btn.title = 'Settings';
    statusbarRight.insertBefore(btn, statusbarRight.firstChild);
    return btn;
  }

  async function doLogin(server, name) {
    server = normalizeServerUrl(server);
    name = (name || '').trim().slice(0, 24);
    if (!server || !name) return false;

    await savePrefMirrored(SERVER_KEY, server);
    await savePrefMirrored(LOGIN_KEY, 'true');
    localStorage.setItem(NAME_KEY, name);

    await requestNotificationPermission();
    await startBackgroundService(name);

    // Reload so boot-config.js picks up the (possibly new) server URL and
    // app.js opens a fresh socket connection against it from a clean state.
    window.location.reload();
    return true;
  }

  async function doLogout() {
    if (window.__lanchatSocket) window.__lanchatSocket.disconnect();
    await savePrefMirrored(LOGIN_KEY, 'false');
    await stopBackgroundService();
    window.location.reload();
  }

  document.addEventListener('DOMContentLoaded', async () => {
    if (native) {
      native.CapApp.addListener('appStateChange', (state) => { appIsActive = !!state.isActive; });
    }

    if (!isApp) {
      // Plain browser / LAN webpage usage — unchanged original behaviour.
      if (window.__lanchatSocket) window.__lanchatSocket.connect();
      return;
    }

    const loggedIn = localStorage.getItem(LOGIN_KEY) === 'true';
    const savedServer = localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
    const savedName = localStorage.getItem(NAME_KEY) || '';

    if (loggedIn && savedServer && savedName) {
      // Returning logged-in user — connect straight away, like reopening WhatsApp.
      if (window.__lanchatSocket) window.__lanchatSocket.connect();
      await requestNotificationPermission();
      await startBackgroundService(savedName);

      // Safety net: if this saved server doesn't respond (wrong IP, server
      // off, changed network, etc.) don't leave the person stuck staring at
      // the static "connecting…" text with no way out.
      let joined = false;
      window.addEventListener('lanchat:joined', () => { joined = true; }, { once: true });
      setTimeout(() => {
        if (!joined) {
          const statusEl = document.getElementById('joinHint');
          if (statusEl) statusEl.textContent = 'Connect nahi ho pa raha — ⚙️ Settings se server address check karein ya Logout karke dobara try karein.';
        }
      }, 8000);
    } else {
      const overlay = buildLoginOverlay();
      const nameInput = overlay.querySelector('#lcNameInput');
      const serverInput = overlay.querySelector('#lcServerInput');
      const loginBtn = overlay.querySelector('#lcLoginBtn');
      const statusEl = overlay.querySelector('#lcLoginStatus');

      nameInput.value = savedName || (await detectDeviceName());
      serverInput.value = savedServer;

      loginBtn.addEventListener('click', async () => {
        statusEl.textContent = 'Connecting…';
        const ok = await doLogin(serverInput.value, nameInput.value);
        if (!ok) statusEl.textContent = 'Naam aur server address zaroori hai.';
      });
    }

    // ---------- settings (gear icon), wired once the app shell shows up ----------
    const settingsPanel = buildSettingsPanel();
    const settingsServer = settingsPanel.querySelector('#lcSettingsServer');
    settingsPanel.querySelector('#lcSettingsCloseBtn').addEventListener('click', () => settingsPanel.classList.add('hidden'));
    settingsPanel.querySelector('#lcReconnectBtn').addEventListener('click', async () => {
      const server = normalizeServerUrl(settingsServer.value);
      if (!server) return;
      await savePrefMirrored(SERVER_KEY, server);
      window.location.reload();
    });
    settingsPanel.querySelector('#lcLogoutBtn').addEventListener('click', doLogout);

    const gearWatcher = setInterval(() => {
      const btn = addGearButton();
      if (btn && !btn.dataset.wired) {
        btn.dataset.wired = '1';
        btn.addEventListener('click', () => {
          settingsServer.value = localStorage.getItem(SERVER_KEY) || '';
          settingsPanel.classList.remove('hidden');
        });
      }
    }, 400);

    // Always-reachable fallback, regardless of whether #app is visible yet.
    addPersistentSettingsButton(() => {
      settingsServer.value = localStorage.getItem(SERVER_KEY) || '';
      settingsPanel.classList.remove('hidden');
    });

    window.addEventListener('lanchat:incoming', (e) => {
      if (!appIsActive) showLocalNotification(e.detail.title || 'LAN Chat', e.detail.body || '');
    });
  });
})();
