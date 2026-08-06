(function () {
  'use strict';
  var SERVER_KEY = 'lanchat:serverUrl:v1';
  var DEFAULT_SERVER = 'https://chat.hamariduniya.in';

  // This www/ bundle is packaged ONLY inside the Android app (the plain LAN
  // web version lives separately in backend-patch/public and is untouched).
  // So we always treat this as "the app" — no need to detect it at runtime,
  // which was fragile: if the native Capacitor bridge hadn't finished
  // injecting yet when this script ran, isApp came out false, the login
  // screen never showed, and the app tried (and failed) to auto-connect to
  // the wrong address — leaving the original "connecting…" text stuck
  // forever with no way to proceed.
  window.__lanchatIsApp = true;

  var saved = localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER;
  window.LANCHAT_SERVER_URL = saved;
})();
