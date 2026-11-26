# Roadmap: control a PC through the YBots Windows app

Status: **phases 1 to 3 built** (Alex chose "straight to phase 3", 2026-11-22). Pairing, online
status, watching the screen, and approved commands and shared-folder files work on web, Android
(0.1.14) and Windows (0.4.0). Taking over the mouse and keyboard, and bots driving the screen, are
phase 4 and not built. Requested by Alex on 2026-11-22: the Android app and the web app should be
able to control the Windows app, so the Windows app becomes a harness for the laptop or PC it is
installed on, and work can be done on that computer remotely from the phone or the web.

## What was built (phases 1 to 3)

| Piece | Where |
|---|---|
| Machines, the link, PC tools, routes | `server/src/machines.ts` (tables `machines`, `machine_log` in `db.ts`) |
| Pairing a PC (same QR flow, `kind: "machine"` + the PC's Ed25519 key; or the short code at `GET /api/auth/pair-code/:code`) | `server/src/routes.ts` |
| PC screen relay, watch only | `server/src/vnc.ts` (`/api/machines/:id/screen`) |
| `pc_*` tools for bots, approval card id + digest sent to the PC | `server/src/mcp.ts`, `agent/loop.ts` (`requestApproval` meta) |
| Windows: rules the PC enforces (paths, approvals, blocked bots, RFB encoder) | `desktop/src/remote-core.js` |
| Windows: key, link, capture, commands, the in-use bar with Stop, settings page | `desktop/src/remote.js`, `pages/remote.*`, `pages/bar.*` |
| Web: Settings › Your PCs (pair by code, bots, watch, activity, remove) and the PC pairing page | `web/src/components/config/PcsSection.tsx`, `PairApprove.tsx` |
| Android: Your PCs (from the account sheet) and the PC screen | `mobile/src/screens/Pcs.tsx`, `PcScreen.tsx` |
| Taking control (input on the PC) | `desktop/src/input.js` |
| Tests | `tests/machines-e2e.mjs` (17 checks through the real server), `tests/machines-electron-e2e.mjs` (the real app), `desktop/tests/remote-core.test.mjs` |

Rules as built:

- **Bots in `PC_BLOCKED_BOTS` can never use a PC.** The server blocks them by name along with siloed and
  outside bots (Sheldon), and refuses switching them on. Each PC can refuse bots by name on its own as well.
- New PCs start with every bot that may use PCs (Howard, Leonard); switch bots per PC in Your PCs.
- Only the person who paired a PC (their sign-in's `person`) sees, watches or manages it. A PC paired
  from a session that doesn't know its person is visible to the whole account.
- Reads inside shared folders run; every write, move, delete, new folder and command asks on a card.
  The card offers "Always allow" (with a warning): it covers that one bot, that one action and that one
  PC, is listed under Permissions with Ask again, and each use is logged. The PC still receives a
  one-time approval bound to the exact call, marked as always allowed, so its activity line says so.
  Plugin approval stages can only make this stricter, and a stage's ask beats a rule.
- A command asked of a PC with commands off is refused before any card.
- The link uses the window's own cookies, so behind Cloudflare Access it works while the window's
  Access sign-in is valid; over Tailscale it needs nothing more. **(Unverified on a real Windows PC
  behind Access: a per-PC service token may be needed if the Access session expires while the app is
  in the tray.)**
- The screen is captured with `desktopCapturer` about twice a second, at most 1600 pixels wide, and
  sent as changed 128-pixel tiles in Tight JPEG; checked here with noVNC, **not yet measured on a real
  Windows PC**.

## Taking control (built 2026-11-22, Windows app 0.5.0)

Alex asked for taking over a PC's screen, mouse and keyboard (2026-11-22). As built:

- **Only people, never bots.** You take control from Settings › Your PCs on the web (Take control)
  or from Your PCs on Android (Take control, with the same touch bar as a bot's computer). Bots get no
  input tool; a bot working the mouse is still phase 4.
- **The PC must allow it.** A third switch on the PC's page, "Let you take control of the mouse and
  keyboard", off by default and only available with screen viewing on. The server refuses
  `?mode=control` before asking the PC while it is off, and the PC checks again. Turning it off ends
  control at once.
- **One driver at a time.** Others can still watch.
- The bar on the PC says "Someone is controlling this PC through YBots", with Stop, which turns
  everything off. Taking control and its end are logged on the PC and in the PC's activity.
- Pointer and key events pass the relay in control mode; **the clipboard never rides the screen
  stream** (it is dropped at the server and ignored at the PC). Copy and paste is its own,
  explicit feature below.
- Whatever is held down when control ends (a dropped connection included) is released.
- Frames come about every 150 ms while someone drives (500 ms while only watching).

How input happens on Windows: one PowerShell child (`powershell.exe -NoProfile -NonInteractive
-EncodedCommand`, no window) compiles a small C# class with `Add-Type` that calls user32 `SendInput`,
and reads one event per line. Nothing native is bundled. Keysyms map to virtual keys (arrows, F-keys,
modifiers, keypad) or go as Unicode characters; with Ctrl, Alt or Windows held, characters go as
their key so shortcuts like Ctrl+C work. Code: `desktop/src/input.js`.

Limits, from Microsoft's SendInput page: input only reaches apps at the same or lower integrity
level (UIPI), and a blocked call doesn't say so. The app never runs elevated, so **elevated windows
and the UAC prompt can't be driven, and Ctrl+Alt+Del can't be sent**. Full-control products get
around this by running as a Windows service; that is not planned here.

Tested: the mapping (`desktop/tests/remote-core.test.mjs`), the server's refusals and filtering
(`tests/machines-e2e.mjs`), and the real Electron app moving the real pointer on Linux, where
xdotool stands in for SendInput (`tests/machines-electron-e2e.mjs`). The C# compiles (checked with
Mono) and its INPUT struct is 40 bytes, as on 64-bit Windows. **SendInput itself is not yet tried on
a real Windows PC.**

## Copy and paste (built 2026-11-22)

Alex asked for copy and paste between a bot's computer (or a PC) and his laptop or phone while
taking control (2026-11-22). Same on web, Android and the Windows app:

- **While driving, two buttons:** *Paste* (this device's clipboard goes onto the remote clipboard,
  then Ctrl+V is pressed there) and *Copy* (the remote clipboard comes onto this device). On the web
  and Windows app they sit in the bar under the screen, and the shortcuts work while the screen has
  focus: Ctrl/Cmd+V pastes from this device, and Ctrl/Cmd+C copies there and then brings it over
  (only if it changed, so Ctrl+C in a terminal doesn't overwrite your clipboard). On phones (Android
  app and the web on a phone) a Copy/paste button in the touch bar opens "Paste from phone" and
  "Copy to phone".
- **Text only, 256 KB at most, never in the background.** Nothing moves unless the person presses a
  button or the shortcut. The text is never stored or logged.
- **Bots' screens (Host2):** `GET`/`PUT /api/bots/:id/clipboard` for the bot's owner; the server sets
  and reads the X clipboard of the bot's display with `xclip` (installed by `scripts/setup-local.sh`).
  Siloed and outside bots have no screen here, so no clipboard.
- **Paired PCs: opt-in per PC.** A fourth switch on the PC's page, "Allow copy and paste while you have
  control", off by default and only available with taking control on. `GET`/`PUT
  /api/machines/:id/clipboard` works only while that switch is on **and** someone has an open control
  session; the server checks both before asking the PC, and the PC (`handleClip` in
  `desktop/src/remote-core.js`) checks both again. The PC's bar then reads "Someone is controlling this
  PC through YBots · copy and paste on", and the web and Android show "Copy and paste on". Each use
  is logged on the PC and in the PC's activity ("pasted to the PC" / "copied from the PC"), never the
  text. Bots have no clipboard tool.
- Browsers ask once for permission to read the clipboard; if reading or writing is refused, a small box
  takes the text by hand instead. The Windows app grants clipboard reading to the YBots address only.

Tests: `tests/clipboard-local.mjs` (real Xvfb + xclip, Unicode, limits), `tests/machines-e2e.mjs`
(off by default, only during control, cross-site refused, never logged), `desktop/tests/remote-core.test.mjs`.

## Firm PCs (Alex, 2026-11-22)

Some paired PCs will be used for firm work. Alex chose to treat them like any PC: bots work only
in the folders shared on that PC, with a card for every change, and he accepted that files in those
folders can reach Host2 and the bots' models. So: share only folders that hold no firm data you
don't want bots to read. Screen viewing and taking control are for you only; no bot sees the screen.
Whether the firm allows remote-control software on its PCs is for the firm to say **(unverified)**.

This page says how the PC would connect, what it could do, how approvals apply, what can go wrong,
and the order to build it in. Facts about other products are cited; anything not checked against a
source is marked **(unverified)**.

## 1. The short version (the original plan)

- The Windows app opens **one outbound connection** to the YBots server on Host2 and keeps it
  open. Nothing on the PC listens for connections. It works through Cloudflare Access (the public
  address) or Tailscale, the same two ways the app already reaches the server.
- The server treats a connected PC as **one more computer** next to the bots' screens on Host2.
  Phone and web open it the way they already open a bot's computer.
- The bots' brains stay on Host2. The PC only **carries out tool calls** (look at the screen, click,
  type, read a file, run a command) that the server sends it. Every call that changes anything on the
  PC needs an **approval card answered by you**, and the PC itself refuses anything that wasn't
  approved.
- Four phases: **1** pair and show online, **2** view the screen, **3** approved commands and files,
  **4** full harness (bots drive the PC). Each phase ships on web, Android and Windows together.

## 2. What already exists that this reuses

| Piece | Where | How it is reused |
|---|---|---|
| QR pairing of a PC | `server/src/routes.ts` (`/api/auth/pair`), `desktop/` 0.3.0 | Same pattern to pair the PC **as a machine**, a second, separate step after signing in. |
| Live computer view | `server/src/vnc.ts` (`/api/bots/:id/screen`, `watch` / `control`), web noVNC, Android `mobile/src/screens/Computer.tsx` (noVNC in a WebView) | The PC screen is relayed through the same socket shape, so both viewers work almost unchanged. Watch mode already drops input on the server. |
| Screens on Host2 | `server/src/local-computer.ts`, `computer.ts`, `desk.ts` | A PC becomes another entry in the computers list, with its own status. |
| Approval cards | `server/src/agent/loop.ts` (`resolveApproval`, digest-bound, expiring, readback) | Every PC action that changes something goes through the same cards. |
| Approval check for tools | `agent/tools.ts` (`policyFor`), `plugins/policy.ts` (stages: strictest wins) | PC tools are served through `/mcp` like any other tool, so the same rules apply. |
| Hermes tool gate | `server/hermes-plugins/cleft-bot-gate` | Unchanged; PC tools come through `/mcp`, which is already gated. |
| Plugin rules | `docs/plugins.md` | Plugins may add `ask`/`block` for PC tools. They can never allow, and never answer a card. |
| Phone access tokens | Cloudflare Access service tokens on phones | The PC uses its own token (or Tailscale) for the machine link, revocable on its own. |

## 3. How the PC registers (outbound only)

1. **You choose "Let YBots use this PC"** in the Windows app (off by default). The app makes a
   key pair on the PC (kept with Windows' per-user data protection **(unverified which API; DPAPI via
   Electron `safeStorage` is the likely route)**).
2. **The PC shows a QR code and short code**, exactly like sign-in. You scan it on your phone and
   tap **Allow this PC** after checking the code and the PC name. That registers the PC's public key
   with your account. Scanning alone gives nothing; the PC holds the secret.
3. **The PC opens a WebSocket** to `wss://<your Cleft address>/api/machines/link` and proves it
   holds the key (signs a server challenge). The server marks it **online**. The PC never accepts
   incoming connections.
4. **Keepalive and reconnect.** Cloudflare proxies WebSockets on all plans, but may restart servers
   and close connections, and closes idle ones, so a keepalive is needed
   ([Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)). The app pings
   every ~30 s and reconnects with backoff. A dropped link cancels anything in flight; nothing is
   retried without a new approval.
   - The pairing is bound to the address it was made with (scheme, host and port). If the app's
     YBots address changes, the PC stops connecting and says "Pair again for the new address";
     it never sends its identity or settings to the new address. A new key pair is saved only when
     its pairing is allowed, so starting a second pairing cannot break the first.
   - Stop (bar, tray, or turning remote use off) also ends commands that are still running, with
     their whole process tree, and a connect that was still starting gives up.
5. **Network paths.**
   - Cloudflare Access: the app already passes Access sign-in in its window. The machine link should
     use a **separate service token per PC**, as the phones do, so one PC can be cut off alone.
   - Tailscale: works with no inbound ports opened; Tailscale only needs outbound connections and
     falls back to relays when a direct path fails
     ([Tailscale firewall ports](https://tailscale.com/kb/1082/firewall-ports)). Either path is
     outbound from the PC.
6. **Removing a PC.** From any of the three apps: **Remove this PC** revokes its key at once and
   closes the link. On the PC itself, turning the switch off or quitting the app does the same.

## 4. What a connected PC can do

Each line is a tool the server can ask the PC to run. **Bold** ones change something and always ask.

| Tool | What it does | Default rule |
|---|---|---|
| `pc_status` | Online, user, screen size, locked or not | runs |
| `pc_screenshot` | One picture of the screen | runs while a viewer is open or the bot has a task on this PC; shown in the activity list |
| `pc_view` | Live view for you (watch) | runs; **take over** (control) needs a tap on your device each time |
| `pc_list_files` / `pc_read_file` | Inside folders you shared only | runs inside shared folders; anything else refused |
| **`pc_write_file`** / **`pc_move`** / **`pc_delete`** | Inside shared folders | asks |
| **`pc_run`** | Run one command (PowerShell or cmd) | asks, every time; card shows the exact command, folder and time limit |
| **`pc_click` / `pc_type` / `pc_key`** | Drive the mouse and keyboard | asks once per task, for one bot, for a set time (see §5) |
| **`pc_open_app`** | Start an app | asks |
| `pc_clipboard_read` | Read the clipboard | asks (it often holds passwords) |

**Shared folders**: you pick them on the PC (for example `Documents\Cleft`). The PC refuses any path
outside them after resolving links and `..`, so a bad path is stopped on the PC, not just on the
server.

**How the screen is shown.** Electron's `desktopCapturer` can list and capture whole screens and
windows, called from the main process
([Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)). Two ways
to get that to the viewers:

- **A (recommended): a small RFB (VNC) server inside the app**, fed by those frames, carried over
  the outbound link and relayed by `vnc.ts`. Web and Android keep their noVNC viewers; watch mode
  keeps dropping input on the server. Cost: we write a minimal RFB encoder (raw or JPEG-like
  tiles). **(unverified: frame rate we can reach on a laptop.)**
- **B: bundle an existing Windows VNC server** listening on the PC's loopback only. Faster to get
  going, but it adds a second program with its own updates and licence to check, and a listener on
  the PC (loopback only).

**Mouse and keyboard.** Electron has no input injection of its own **(unverified, no Electron API
found)**, so it needs a native module. Options checked:
- `nut.js`: open-source core you build yourself; prebuilt packages are paid (from $20/month)
  ([nut.js pricing](https://nutjs.dev/pricing)).
- `@jitsi/robotjs`: MIT, supports Windows, prebuilt by Jitsi's CI
  ([README](https://unpkg.com/@jitsi/robotjs@0.6.24/README.md)); how actively it is kept up is not
  stated.
- A tiny module of our own around Windows `SendInput`. Recommended later; robotjs is fine to start.

**Running bots against the PC's own tools.** Hermes now runs natively on Windows 10/11 without WSL
([Hermes on Windows](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native)), so a
second option is a Hermes on the PC. This plan **does not** do that: the bots stay on Host2, keep
one memory, one model setting and one approval gate, and reach the PC only through the tools above.
Running Hermes on the PC would mean a second copy of every bot's setup and a second gate to keep
honest. Revisit only if latency is a real problem.

## 5. How approvals apply

The rules that already hold everywhere hold here too:

1. **A bot message is never an approval.** Nothing a bot, a plugin or a PC says counts as a yes.
2. **Only you answer cards**, on your phone, the web app or the Windows app, signed in as you. The
   card names the PC, the bot, the exact action (command text, file path, or "control mouse and
   keyboard for 15 minutes") and expires like every card (25 minutes).
3. **The approval is bound to the action.** The server sends the PC the action together with the
   approval's id and digest. The PC checks the digest against the action itself before running it,
   and keeps a list of used approval ids, so one approval runs one thing once. A command that differs
   by one character is refused on the PC.
4. **Plugins can only make it stricter.** A plugin stage can turn `allow` into `ask` or `block` for
   any `pc_*` tool. It can't loosen a rule or answer a card (`docs/plugins.md`).
5. **"Always allow" is narrower here.** For `pc_run` and input control there is no "Always allow":
   only **Allow once**. Read tools inside shared folders may be always-allowed per PC.
6. **On the PC itself, you can always see and stop it.** While a bot is acting, the tray icon
   changes and a small always-on-top bar says "Leonard is using this PC" with a **Stop** button.
   Stop drops the bot's control at once and cancels the task. Moving the real mouse also pauses
   bot input **(unverified that we can detect this reliably; design goal)**.
7. **Sheldon stays walled off.** No PC tools for Sheldon or any outside bot. A PC can also be marked
   for chosen bots only (for example Leonard and Howard), using the same per-bot switches
   as plugins.

## 6. Security risks, plainly

| Risk | What could happen | What limits it |
|---|---|---|
| Server or account taken over | Someone with your Cleft sign-in or control of Host2 could try to drive your PC. | PC actions need a fresh card answered from a signed-in device; the PC checks digests itself; you can remove the PC from any app; the PC switch is off by default. Host2 compromise remains the biggest risk: whoever controls the server controls what cards are shown. |
| Approving the wrong thing | A long command or a misleading file name gets approved by mistake. | Cards show the exact text, the folder, a plain-language line for common commands, and no "Always allow" for commands. |
| Prompt injection | A web page or file the bot reads tells it to run something. | It can only *ask*; you still see the card. Bots never approve. |
| Screen privacy | Banking, messages, other people's data on screen get sent to the server and the model. | Viewing is visible on the PC (tray + bar); screenshots only during a task or open viewer; you can pause sharing. Firm work on a PC that has Cleft remote control turned on is a firm-policy question, not one this plan answers. |
| Elevated windows and UAC | Windows blocks a normal app from sending input to apps running at a higher integrity level (admin) ([SendInput](https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput), [UIPI](https://en.wikipedia.org/wiki/User_Interface_Privilege_Isolation)). | We keep it that way: the app runs as a normal user, never elevated, so a bot can't click through admin prompts. Tasks needing admin are handed back to you. Note: Microsoft calls UIPI "a security feature but not a security boundary". |
| Command runs too long or too wide | A command deletes more than meant or hangs. | Time limit on every `pc_run`, working folder fixed to a shared folder, output size capped. **(Further containment, such as a Windows job object or a separate low-rights user, is unverified and left for phase 3 design.)** |
| Stolen PC key | Someone copies the PC's key and pretends to be the PC. | Key is in per-user protected storage; a fake PC can only *receive* tasks you approve, not act on your account; removing the PC revokes it. |
| Link dropped mid-task | A command half-runs. | Nothing is retried without a new card; the result is reported as "connection lost, outcome unknown" with whatever the PC logged. |
| Unsigned app | The Windows zip isn't code-signed; a tampered copy could be passed around. | Only install from our own builds; adding code signing is worth reconsidering once this exists. |

Every PC action, allowed or refused, is logged on the server (bot, PC, tool, card id, result) and the
last 200 are kept on the PC too, so both sides can be compared.

## 7. Parity: web, Android, Windows

Per the standing rule, every phase lands on all three apps.

| Feature | Web | Android | Windows app |
|---|---|---|---|
| See your PCs and online status | Computers list | Computers list | Same list, plus "This PC" |
| Pair a PC | Scan the QR from any phone browser, or approve the code | Approve in the app (its own scanner is still on the Windows plan's "not yet" list; phone camera works now) | Shows the QR; turns the switch on |
| Watch the screen | noVNC (existing) | noVNC WebView (existing) | Yes (to view another PC) |
| Take over | Mouse and keyboard | Touch controls from PR 23 / the computer view | Yes |
| Approval cards for PC actions | Yes | Yes | Yes, plus the on-PC "in use" bar and Stop |
| Shared folders and permissions | Settings page | Settings tab | Settings, plus folder picker (picking folders only works on the PC itself) |

UI constraints to raise early:

- **Choosing shared folders** has to happen on the PC (a Windows folder picker). Phone and web can
  view and remove them but not browse to new ones until phase 3 adds a remote folder browser.
  Options: (a) PC-only picking, (b) a remote browser limited to the user folder. Recommend (a) first.
- **Take-over on a phone screen** is cramped for a full Windows desktop. The existing pinch/zoom and
  touch controls carry over; a keyboard row with Ctrl/Alt/Win/Tab keys would be added to Android
  and phone web.

## 8. Phased plan

| Phase | What ships | Server | Windows app | Web + Android |
|---|---|---|---|---|
| **1. Pair and show online** | PC appears in the Computers list with online/offline and last seen; remove from anywhere | `machines` table, `/api/machines/pair`, `/api/machines/link` (WebSocket, challenge signing, keepalive), audit log | Switch (off by default), key pair, QR, outbound link with reconnect, tray state | PC row with status, Remove |
| **2. View** | Watch the PC screen live; take-over only with a fresh tap | `vnc.ts` relays `/api/machines/:id/screen` over the link | `desktopCapturer` frames to an in-app RFB server; input via robotjs for take-over only; "being viewed" bar with Stop | Existing viewers point at the PC |
| **3. Approved commands and files** | Bots (and you) can list/read shared folders, and with a card write files and run commands | `pc_*` tools in `/mcp`, `policyFor` entries, digest sent with each action, per-PC bot switches, plugin stages cover `pc_*` | Shared folders, path checks, digest check, used-id list, time limits, local log | Shared-folder settings, PC tools on cards, per-bot switches |
| **4. Full harness** | A bot works on the PC end to end: sees the screen, clicks, types, opens apps, under a time-boxed control card | `pc_click`/`type`/`key`/`open_app`, control sessions bound to bot + PC + minutes | Input injection for bots, pause on real mouse movement, Stop always on top | "Leonard is working on Office PC" live status, stop from phone |

Phase 1 is small and carries no new risk to the PC (it can't do anything yet). Phase 2 is the first
one where data leaves the PC. Phase 3 is the first one where a bot can change something on it.

## 9. Open questions for Alex

1. Which phase to start with (recommend 1, then 2 right after).
2. Which PCs: just yours, or Sam's too (she'd pair her own, under her own account)?
3. ~~Is any of these PCs used for firm work?~~ Yes; see "Firm PCs" above.
4. ~~Commands: PowerShell only, or cmd too?~~ PowerShell only.

## Sources

- Electron desktopCapturer: https://www.electronjs.org/docs/latest/api/desktop-capturer
- Windows SendInput (UIPI note): https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-sendinput
- User Interface Privilege Isolation: https://en.wikipedia.org/wiki/User_Interface_Privilege_Isolation
- Cloudflare WebSockets: https://developers.cloudflare.com/network/websockets/
- Tailscale firewall ports: https://tailscale.com/kb/1082/firewall-ports
- Hermes Agent on Windows (native): https://hermes-agent.nousresearch.com/docs/user-guide/windows-native
- nut.js pricing (prebuilt packages are paid, so not used): https://nutjs.dev/pricing/core
- ConnectWise on controlling UAC prompts (needs a service): https://docs.connectwise.com/ScreenConnect_Documentation/Get_started/Knowledge_base/Control_Windows_UAC_dialogs
- @jitsi/robotjs README: https://unpkg.com/@jitsi/robotjs@0.6.24/README.md
- Repository code read for this plan (main 07fc522): `server/src/vnc.ts`, `local-computer.ts`,
  `computer.ts`, `routes.ts` (pairing), `agent/loop.ts`, `agent/tools.ts`, `docs/plugins.md`,
  `docs/windows-app.md`, `desktop/src/policy.js`.
