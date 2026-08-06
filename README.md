# LAN Chat — Mobile (Android APK)

## ✨ Is update me kya badla (UI + attachment fix)

**UI — ab WhatsApp jaisa lagta hai:**
- Poora theme WhatsApp-style dark palette me badal diya (header app-bar,
  message bubbles ab "tail" ke saath, chat wallpaper texture, rounded pill
  composer, floating round send button).
- Attach (📎) button ab ek bottom sheet kholta hai — **Gallery / Camera /
  Document** — bilkul WhatsApp jaisa, seedha file picker khulne ke bajaye.
- Private chat ka header ab back-arrow ke saath chat-screen jaisa dikhta hai.

**Attachment "nahi ja raha" — asli wajah aur fix:**
Pehle poori file ek hi bade base64 packet me silently bhej di jaati thi —
agar wo slow ho ya fail ho jaaye to user ko **kuch pata hi nahi chalta tha**.
Aur received file ka "Download" link ek `data:` URL anchor tha, jo Android
WebView me reliably kaam nahi karta.

Ab:
- Files **chhote acknowledged chunks** me bheji jaati hain (background
  `file-begin` → `file-chunk` → `file-end`, har step server se confirm hota
  hai), isliye bade photos/videos bhi bharosemand tarike se jaate hain.
- Har bheji ja rahi file par ek **live progress bar** dikhta hai
  ("Bhej rahe hain… 42%"), aur agar kuch fail ho jaaye to seedha
  **"↻ Dobara try karein"** button milta hai — silent failure ab nahi hoga.
- Received file ka **"Save"** button ab native Filesystem + Share plugin use
  karta hai — Android ka asli save/share sheet khulta hai (jaisa WhatsApp me
  hota hai), jo `data:` link se zyada reliable hai.

`npm install` (ya CI wala `npm install` step) is baar `@capacitor/filesystem`
aur `@capacitor/share` bhi le aayega — ye already `package.json` me add kar
diye gaye hain, koi extra manual step nahi chahiye.

---

Aapke `lan-chat-fixed` LAN chat app ka mobile version. Isme original web app ke
saare features (group chat, private chat, file/attachment sharing, screen
share, Tic-Tac-Toe/Snake/Memory games, dark-light theme) waise hi hain — bas
ab yeh ek asli Android app (.apk) hai jisme:

- **Server address change** ka option hai (Settings ⚙️) — office LAN me IP:port
  daalein, ya kahin se bhi `https://chat.hamariduniya.in` (ya koi bhi apna
  address) daal kar connect karein.
- **Login/Logout**: Login karte hi background service start hoti hai (notification
  bar me chhota persistent icon dikhega — WhatsApp ki tarah), aur tabhi tak chat
  backend me active rehta hai. Logout karte hi background service band ho jaati
  hai.
- **Username/password nahi chahiye** — bas device ka naam auto-fill hota hai
  (edit kar sakte hain), aur ek baar login karne ke baad wahi naam yaad rehta
  hai (refresh/reopen par baar-baar naya naam nahi banega).
- **Notifications**: naya message aane par, jab app background me ho, local
  notification aati hai.

## ⚠️ Zaroori: APK is sandbox me nahi ban sakta

APK compile karne ke liye Android SDK + Google ka Maven repo chahiye hota hai,
jo is (Claude ke) sandboxed environment me allow nahi hai. Isliye maine
`.github/workflows/build-apk.yml` bana diya hai — ye **GitHub Actions** use
karke apne aap APK build kar dega jab aap is project ko apne GitHub account par
push karenge. GitHub Actions runners ke paas poora internet access hota hai,
isliye wahan build ho jayega.

## Steps — GitHub se APK banayein

1. GitHub par ek naya (empty) repository banayein — e.g. `lan-chat-mobile`.
2. Is poore folder (jo aapko diya gaya hai) ko us repo me push karein:
   ```bash
   cd lan-chat-mobile
   git init
   git add .
   git commit -m "LAN Chat mobile app"
   git branch -M main
   git remote add origin https://github.com/<aapka-username>/lan-chat-mobile.git
   git push -u origin main
   ```
3. GitHub par apne repo ke **"Actions"** tab me jayein — "Build LAN Chat APK"
   workflow apne aap chalna shuru ho jayega (2-4 minute lagte hain).
4. Workflow poora hone ke baad, us run ko open karein — neeche
   **"Artifacts"** section me `lan-chat-debug-apk` milega. Download kar lein
   (ek `.zip` milega jisme APK hoga).
5. APK ko phone me transfer karein (WhatsApp/email/USB/Drive — jo bhi tarika
   suit kare) aur install kar lein. Pehli baar "Unknown apps install karne
   dein" wala Android permission maangega — allow kar dein.

Agar aap chahein to `workflow_dispatch` ki wajah se Actions tab se manually
bhi "Run workflow" button dabakar re-build kar sakte hain, bina naya push
kiye.

## App kholne ke baad

1. Pehli baar app khulega to naam (device se) aur server address poochega.
   - Office LAN par: server ke IP:port daalein (jaise `192.168.1.10:3000` —
     yeh wahi address hai jo aapka `server.js` console me print karta hai).
   - Internet se/kahin se bhi: `https://chat.hamariduniya.in` (ya jo bhi
     domain aap us backend ko deploy karke denge) daalein.
2. **Login & Connect** dabayein — background service start ho jayegi.
3. Header me ⚙️ (gear) icon se kabhi bhi server address badal sakte hain ya
   Logout kar sakte hain.

## Backend (server.js) side

Backend me koi structural change nahi kiya hai — wahi `server.js` jo aapne
diya, wahi office LAN par ya `chat.hamariduniya.in` par chalega. Bas dhyan
rakhein:

- Agar aap `chat.hamariduniya.in` se connect karwana chahte hain, to wahan
  yehi `server.js` (Node.js) already deployed/running hona chahiye, HTTPS ke
  saath (jaisa server.js khud self-signed cert bhi bana sakta hai, ya aap apna
  domain SSL cert use karein — jo already deployed hai to bas usi address ko
  app ki Settings me daal dein).
- CORS: agar backend aur app alag origins par hain (jo mobile app case me
  hamesha hoga), to `server.js` me Socket.IO CORS allow honi chahiye. Agar
  abhi CORS block ho raha ho, `server.js` me `Server(..., { cors: { origin: '*' } })`
  jaisa add karna padega.

## Known limitation

- **Screen share**: yeh feature WebRTC (`getDisplayMedia`) par based hai, jo
  Android WebView me officially support nahi hai (kuch devices par kaam kar
  sakta hai, guarantee nahi). Baaki saare features (chat, private chat,
  files, games, themes) fully kaam karte hain.
