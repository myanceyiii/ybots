# Third-party notices

YBots is MIT-licensed (see `LICENSE`). It bundles or depends on the third-party work listed below. npm dependencies not listed here are covered by their own licenses, included in their packages.

## Lucide icons

The web UI's icons come from [Lucide](https://lucide.dev), via the `lucide-react` package (pinned to 1.61.0 in `web/package.json`). They are rendered in `web/src/components/Icon.tsx`, `web/src/components/config/glyphs.tsx` and `web/src/components/VoiceCallBar.tsx`.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

Some Lucide icons are derived from [Feather](https://feathericons.com). Those are under the MIT License:

```
Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Hermes Agent

The bots run on [Hermes Agent](https://github.com/NousResearch/hermes-agent) by Nous Research, which is MIT-licensed. Hermes is installed and run as a separate program; no Hermes code is copied into this repository.

## App logos

The Connect Apps screen and app cards show each app's logo by loading it at runtime from Composio's logo service (`https://logos.composio.dev/api/<toolkit>`). Approval cards also show bundled logos (see Simple Icons below). When no logo fits, the UI shows a glyph or a letter tile instead. Each logo is a trademark of its owner, and showing one implies no endorsement.

The "Sign in with Google" button shows Google's "G" mark, which is a trademark of Google LLC.

## Original artwork

The bot characters (`server/src/avatar-shapes.ts`, drawn by `web/src/avatar/BotAvatar.tsx` and on each bot's home screen), the app icons, `assets/icon.svg` and the README art in `assets/readme/` were made for this project. The characters and icons are built from basic geometry and covered by the project's MIT license.

The README art has its text turned into outlines of three fonts under the [SIL Open Font License 1.1](https://openfontlicense.org): [Space Grotesk](https://github.com/floriankarsten/space-grotesk) (Florian Karsten), [Inter](https://github.com/rsms/inter) (Rasmus Andersson) and [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono) (JetBrains). The fonts themselves are not bundled. The art is drawn by `scripts/brand/build-readme-art.mjs`; see [docs/brand.md](docs/brand.md).

## noVNC (phone app)

The Android app's computer screen bundles [noVNC](https://github.com/novnc/noVNC) 1.7.0 (`@novnc/novnc`, pinned in `mobile/package.json`), unmodified, into the page `mobile/scripts/build-vnc.mjs` builds for its WebView. noVNC is licensed under the Mozilla Public License 2.0 (https://mozilla.org/MPL/2.0/); its source is available from the link above and from the npm package. The web app uses the same package from `web/package.json`.

## Pipecat (phone call service, installed by deploy/calls/install.sh)

Pipecat (github.com/pipecat-ai/pipecat) is used as a library by the call service under the BSD 2-Clause
License. Copyright (c) 2024-2026, Daily. Its bundled Silero VAD model is under the MIT License.

## Moonshine Voice (live dictation service, installed by deploy/live-stt/install.sh)

`moonshine-voice` (https://github.com/moonshine-ai/moonshine) is installed from PyPI into
/opt/cleft-live-stt on the server; it is not copied into this repository. Its code and its English
streaming models are under the MIT License. Copyright (c) Moonshine AI / Useful Sensors.

## Simple Icons (approval card logos)

The app logos on approval cards (`server/src/card-icon.ts`, copied to `mobile/src/cardIcon.ts`) are path data from [Simple Icons](https://simpleicons.org) 16.38.1, released under CC0-1.0 (public domain). The card glyphs in the same file come from Lucide (lucide-static 1.81.0, ISC, license above). Both are bundled; nothing is fetched at runtime. Brand names and logos belong to their owners and are shown only to identify the app a card is about. Regenerate with `scripts/icons/build-card-icons.mjs`.

## A2UI

Answer views can draw [A2UI](https://a2ui.org) 1.0 interfaces (`server/src/a2ui.ts`, copied to `mobile/src/a2ui.ts`).
A2UI is Copyright Google LLC and contributors, licensed under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). The engine here is a smaller re-implementation; its `${...}`
expression syntax follows the A2UI web_core expression parser. `tests/fixtures/a2ui/*.json` are the A2UI v1.0
Basic catalog examples, copied unchanged from the `@a2ui/web_core` 0.16.1 npm package (Apache-2.0). The A2UI icon
drawings (`server/src/a2ui-icons.ts`) are Lucide paths (lucide-static 1.81.0, ISC, license above).

## OpenBot (check-in offer card)

The check-in offer card (`server/src/checkin-offer.ts`, `CheckInOffer` in `web/src/components/cards/ViewCard.tsx` and `mobile/src/components/ViewCard.tsx`) follows the design and wording of OpenBot's check-in offer (`shared/check-in-offer.ts` and `app/src/lib/copilot/check-in-offer-tool.tsx`, https://github.com/CopilotKit/OpenBot at f681239). No code is copied; the idea, the tool name and the card's text are adapted. OpenBot is under the MIT License, Copyright (c) 2026 CopilotKit.

## OpenBot (Teach a bot recorder masking)

`server/src/vendor/openbot/recorder-masking.ts` is copied unchanged from [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) at commit `f681239a0d8e92f990848427ccaa318ac5c1657b` (`shared/recorder-masking.ts`). The page script in `server/src/teach-page.ts` adapts `describeDemonstrationTarget` and `SENSITIVE_FIELD` from `shared/demonstration-rules.ts` at the same commit. Both are under the MIT License, Copyright (c) 2026 CopilotKit; the full text is in `server/src/vendor/openbot/LICENSE`.

## Saved logins (design only)

The saved-login vault (`server/src/vault.ts`) follows the design of Merit-Systems/OpenInstinct
(github.com/Merit-Systems/OpenInstinct, MIT): the bot lists safe metadata with opaque handles and asks to
fill by handle, the page origin comes from the browser, and values never enter the agent's context. No
OpenInstinct code is copied. Encryption uses Node's built-in `crypto` (AES-256-GCM).
