# YBots for Windows

`desktop/` is the Windows app: one Electron window around the YBots web app. Everything the app
does happens in the web app and on the server. The window only remembers your YBots address,
keeps itself on that address and decides which browser permissions the page gets.

It is its own package, like `mobile/`, and not a root workspace, so installing the server never
downloads Electron.

## First run

1. Start YBots. It asks for your YBots address: your tailnet name (`cleft.example.ts.net`)
   or your Cloudflare-protected address. It must be `https://`. Nothing is built into the app.
2. The window opens that address. If the address is behind Cloudflare Access, sign in there first
   (the Access page is allowed in the window).
3. Sign in with your phone: the app shows a QR code and a short code (like `K7P-4QD`). Scan it with
   the camera of a phone where YBots is signed in (in the browser). The phone asks "Sign in YBots
   Bot on <this PC>?" and shows the code; if it matches the PC's screen, tap **Allow**. The PC signs
   in to that same account. A code works once, for 2 minutes; scanning it alone gets nobody in,
   because only the PC holds the secret the server checks (`POST /api/auth/pair`, then the PC's poll
   `GET /api/auth/pair/<id>`; the phone uses `/pair/<id>`). **File > Sign in with QR code…** shows a
   new one.
4. Or **File > Sign in with a link…**: on a signed-in device, open your account menu, choose **Sign
   in another device**, copy the link and paste it. It works once, for 15 minutes. A link from
   `scripts/sign-in-link.sh` works too. Links are always opened on this app's own address, even when
   they name the server's tailnet host.

If the address is behind Cloudflare Access (like `bots.example.com`), the app sees that and
opens the Cloudflare sign-in in its window instead of a QR code: enter your email and the code
Cloudflare sends. The web app then signs you in from that Cloudflare identity on its own
(`CF_ACCESS_*` settings on the server), so no phone or link is needed. The Cloudflare sign-in lasts
as long as the Access session (720 hours). Before 0.5.1 this showed "Couldn't reach <address>",
because Electron's fetch rejects the Access redirect instead of returning it.

The sign-in is kept between starts. **File > Change YBots address…** points it somewhere else
(addresses used before are offered again), and **File > Sign out…** signs this PC out.

If the address can't be reached, the app says what most likely went wrong (this PC is offline,
Tailscale is off, the server is restarting, the address answered with a proxy's error page) and tries
again by itself after 5, 10, 20 and then every 30 seconds, at once when the network comes back, and
when the PC wakes from sleep.

## What the app adds to the web app

Everything bots do is in the web app. The shell adds what only a desktop app can:

- **Tray icon.** Closing the window keeps YBots running by the clock. The icon gets a dot when a bot
  needs you (red: waiting for an answer; blue: something unread), its tooltip says how many, and its
  right-click menu lists those bots: one click opens the chat. The menu also has **Quick Chat**,
  **Pause notifications** (30 minutes, 1 hour, 2 hours, until tomorrow morning), **Start at login**,
  **Settings** and **Quit**.
- **Taskbar button.** A count of the chats that need you, a brief flash when something new arrives
  while the window is not in front, download progress, and a right-click list with **Quick Chat** and
  **Settings**.
- **Quick Chat.** A small window over whatever you are doing: pick a bot (Alt+1 to 9), type, Enter. It
  opens with a global shortcut (Alt+Shift+Y until you change it), from the tray, or from the taskbar
  list. The message is sent as yours and lands in that bot's chat. It can only send a chat message.
  A message can carry up to 8 files of 25 MB each: a **screenshot** of the screen the mouse is on (the
  camera button or Ctrl+Shift+S; the window steps aside first), a picture **pasted** with Ctrl+V, files
  **dropped** on the window or picked with the paperclip (Ctrl+O). Each shows in the window, with an ×
  to take it off, before anything is sent, and goes up the same way the chat's own paperclip sends it.
  A bot that is waiting for you, or has something new, carries a dot. **Send a screenshot to a bot…**
  in the tray menu and the taskbar list takes the picture first, then opens Quick Chat with it attached.
- **Print and PDF.** Ctrl+P prints what is on screen; **File > Save page as PDF…** saves it.
- **Right-click menu.** Cut, Copy, Paste, Paste as plain text, spelling suggestions and Add to
  dictionary, Open link in your browser, Copy link, Copy picture, Save picture as, Search the web.
- **Find on the page** (Ctrl+F, F3, Shift+F3) with a count.
- **The window remembers** its size, place, maximised state and zoom (Ctrl+Plus, Ctrl+Minus, Ctrl+0,
  Ctrl+mouse wheel). A window left on a monitor that is gone opens on one that is there.
- **Menus** for the web app's own shortcuts (New conversation, Search, chat list, full-screen chat,
  previous and next chat, keyboard shortcuts), Back and Forward (Alt+Left, Alt+Right, the mouse's side
  buttons), Reload (Ctrl+R, F5), full screen (F11) and Keep on top.
- **Downloads.** Windows' Save dialog, or straight into a folder you pick under a free name
  (`report (1).pdf`); a notice at the end opens the folder, and a failed download says so.
- **Settings for this PC** (File menu, tray, or `YanceyBot.exe --settings`): start at login, keep
  running when closed, spelling, graphics acceleration, notifications (on/off, sound, taskbar count,
  flash, a test notification), the Quick Chat shortcut, the downloads folder, and diagnostics. It opens
  in its own window, so the chat behind it stays open.
- **Recovery.** A page process that dies is loaded again (three times a minute at most); a window that
  stops responding offers Wait or Reload; settings are written whole, and a settings file that cannot be
  read is set aside (`settings.bad-<time>.json`) instead of stopping the app.
- **Links.** `yanceybot://chat/<bot id>`, `yanceybot://quick`, `yanceybot://screenshot` and `yanceybot://settings` open those
  places. A link can only open a place, never do something there.
- **Help > Copy diagnostics / Open the log folder.** `logs/main.log` in the app's data folder records
  what the app did and what went wrong. It never holds messages, sign-in links, cookies or keys.

- **Updates install themselves** (0.10.0 on). The app asks its own YBots server for a newer version
  (a few seconds after starting, then every six hours), downloads it in the background and uses it the
  next time the app starts. Settings > Updates shows what is happening, has **Check now**, **Restart to
  update** and a switch to turn automatic updates off; the tray menu offers the restart too. The app
  never restarts by itself.
- **This PC is named in "Signed-in devices".** Requests to YBots carry `x-cleft-device`
  ("YBots for Windows, PC-NAME").

Nothing in the shell can answer an approval. A notification, the tray menu and Quick Chat only open a
chat or send a message; approvals are answered on the card.

## What the window allows

- Only your YBots address (and the Cloudflare Access sign-in in front of it) loads in the
  window. Other web links open in your default browser. `file:` and other schemes are dropped.
- The page may use the **microphone** (calls) and **notifications**, and nothing else: no camera,
  screen capture, location or devices. A frame from another site gets nothing.
- The web app gets five calls into the shell and nothing else: show the window, show a notification,
  clear notifications, tell it the theme, and hear which chat a clicked notification was for. The
  app's own pages (setup, offline, settings, find, Quick Chat) are the only ones that can change a
  setting, and only the listed ones. Approvals only happen on the cards in the app.
- No page may pick a Bluetooth, USB, serial or HID device.
- `contextIsolation` and `sandbox` are on, `nodeIntegration` is off, one copy runs at a time.

## Letting YBots use this PC

**File > Let YBots use this PC…** (or the tray menu, or Settings) opens a page in the app's own
settings window, off by default. **Pair this PC** shows a QR code and short code; allow it on a signed-in phone (scan it, or
type the code under Your PCs). Then choose:

- **Shared folders**: the only places bots can read or change files.
- **Allow commands**: PowerShell commands, each one approved on a card.
- **Allow screen viewing**: you can watch this screen from the phone or web.
- **Let you take control**: you (never a bot) can drive the mouse and keyboard from the phone or web.
  Off by default. Elevated windows, the UAC prompt and Ctrl+Alt+Del can't be reached this way.
- **Blocked bots**: refused on this PC whatever the server says.

Each shared folder has **Open** (in Explorer) and is marked when it is no longer there. **Recent
activity** lists what happened with the day and time and can be cleared. **Forget this pairing** asks
twice.

While anyone watches or a bot is working, a bar at the top of the screen says so and has **Stop**,
which turns remote use off at once. The tray menu has **Stop remote use now** too. The PC's key is
kept with Windows' per-user protection (`safeStorage`) in the app's data folder; **Forget this
pairing** deletes it. Details: [remote-pc.md](remote-pc.md).

## Building

```sh
cd desktop
npm install
npm test                       # every shipped file parses, then the rules (address, links, navigation, permissions, settings, badge, keys)
xvfb-run -a npm run test:e2e   # drives the real app against a local stand-in server
npm run dist:win               # portable zip in dist/, builds on Linux too
```

### Releases

Every Windows build is published on the repo's GitHub Releases page as `windows-v<version>`, with the
zip attached, next to the Android publish to your app store. Bump `version` in `desktop/package.json`,
then on the build server run `scripts/release-windows.sh [git-ref] [whats-new.md]`. It builds the zip,
refuses to publish if it finds a secret or private address in it, uploads through the `gh` login
on Host2, then signs the zip and puts it on the YBots server so installed apps update themselves. (GitHub Actions can't build it while the account's Actions budget blocks runners.)

YBots ships as a portable zip (Alex, 2026-11-22): unzip anywhere and run `YanceyBot.exe`. It
isn't code-signed, so Windows SmartScreen warns the first time. `build/after-pack.js` puts the Cleft
Bot icon and name into the .exe with resedit, so no wine is needed.

### How updates stay safe

The update is the same portable zip as on the Releases page. The build server signs "version, SHA-256,
size" with an Ed25519 key that exists only there (`~/.config/yanceybot/update-signing-key.pem`); the
public half is in `desktop/src/update-core.js`. The release script copies the zip and a `latest.json`
manifest to the YBots server (`data/desktop-updates/`), which serves them to signed-in people at
`/api/desktop/latest` and `/api/desktop/download/<file>` (`server/src/desktop-updates.ts`). The app
uses a download only when the signature, the size and the hash all match, so neither the YBots
server nor anyone who got into it can hand a PC a different program or an older version.

A new version is unpacked next to the others in `%LOCALAPPDATA%\YBots\versions\<version>\`,
never over the running copy. Whichever copy is started (the original folder, the Start Menu shortcut)
hands over to the newest complete one. A version that fails to come up twice in a row is left
alone and the app stays on the one that works. Older copies are removed once a newer one has run.
Start with `--no-update` to run exactly the copy you started.

To rotate the signing key, add the new public key to `TRUSTED_KEYS`, ship one release signed with the
old key, then sign with the new one. Losing the key means one more release by hand (a zip to unzip).

## Not yet

An installer and code signing (Windows SmartScreen still warns on the first run of the first zip). See the build plan in the
project files (`windows/windows-build-plan.md`).
