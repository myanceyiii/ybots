# The API contract between the server and the apps

The server, the web app (also what the Windows app shows) and the Android app are released apart. A phone
can run last month's app against today's server, and the Windows app keeps its own copy of the window
around the web app. Every change has to keep the apps people already have working.

This page is the rules and the tools that hold the apps to them. It borrows from OpenBot's
[api-and-migrations.md](https://github.com/CopilotKit/OpenBot/blob/f681239a0d8e92f990848427ccaa318ac5c1657b/docs/api-and-migrations.md)
(MIT), cut down to one self-hosted server.

## Rules

1. **The API only grows.** Add routes and fields. Never remove or rename a route, a field, or a value an
   installed app sends or reads, and never change what one means (its type, what a missing field means,
   the status code of an outcome, an error `code`).
2. **New request fields are optional,** and leaving one out does what happens today.
3. **Replace beside the old.** Add the new route or field, keep answering the old one, and remove the old
   only once no supported app uses it (see the minimum app version below).
4. **Every app is a tolerant reader.** It ignores a field it does not know and treats an unknown value as
   "other". It never sends back a value it did not understand.
5. **One source for each shape.** A shape the server sends is declared once, in the server (mostly
   `server/src/types.ts`). The web app imports it as `@shared/types`, and the Android app does the same
   with `import type` (below). Never copy a server type into an app.
6. **One source for each shared helper.** Code the phone must run itself (message text, reactions, card
   icons, charts) lives in the server file. The phone keeps a word-for-word copy that only
   `npm run shared:sync` writes.

## What holds the apps to it

| Check | What it catches | Where |
| --- | --- | --- |
| `npm test -- shared-copies` | an Android copy of a shared helper that differs from the server file; a phone file that says it copies one but is not on the list; a value (not type) import from `@shared` in the phone | `scripts/shared-copies.mjs`, `tests/shared-copies.mjs` |
| `cd mobile && npm run typecheck` | the phone reading a field the server's shape does not have, or a value it never sends | `mobile/tsconfig.json` maps `@shared/*` to `../server/src/*` |
| `npm test -- app-routes` | an address the phone calls that the server no longer answers | `tests/app-routes.mjs` reads every `req('METHOD', '/path')` in `mobile/src/api.ts` and `mobile/src/robin/hubApi.ts` |
| `npm run typecheck` | the web app reading a shape wrongly; a server handler answering a contract call with the wrong shape | `web/tsconfig.json` `@shared/*`, `server/src/lib/contract.ts` |
| `npm run api:check` | a contract change that would break an installed app | `scripts/api/breaking.mjs`, `tests/api-contract.mjs` |

### Why the phone uses `import type`

The release build (`scripts/release/cleft-release.sh`) ships only the `mobile/` folder to the build
server, so the phone cannot import a server file at run time. `import type` and `export type` are
removed by the build (Babel), so they cost nothing in the app, but `tsc` still reads the server file and
fails when the two disagree. A shape in a server file that imports server code (a database, Node) is not
safe to reach this way: move the shape into `server/src/types.ts` first.

### Shared helpers

`scripts/shared-copies.mjs` lists each `[server file, Android copy]`. A server file on that list must have
no imports. Change the server file, run `npm run shared:sync`, and commit both. `PORTS` lists phone files
that carry only part of a server file, rewritten for the phone (`mobile/src/poses.ts`); keep those in step
by hand.

## The contract file

`server/src/api-contract.ts` names each call once, as `METHOD /api/path` with `{name}` path parts, with
its `query`, `body` and answer (`res`), and the live events (`ApiEvent`, the same union as `ServerEvent`).
It is types only, so every app reads it:

- **The apps** call through it: `call('GET /api/bots/{id}/rows', { id }, undefined, { limit: 200 })` in
  `web/src/lib/api.ts` and `mobile/src/api.ts`. The address is built from the name by `apiPath`
  (`server/src/api-path.ts`, copied to the phone), and the answer is the server's own type.
- **The server** answers those calls with `answer(c, 'GET /api/tasks', { tasks })` (`server/src/lib/contract.ts`),
  so a handler that stops sending what the contract promises fails the typecheck.
- **The spec**: `npm run api:generate` writes `api/openapi.json` (OpenAPI 3.1, events under `x-events`)
  with [ts-json-schema-generator](https://github.com/vega/ts-json-schema-generator) (MIT, a dev tool only).
  Never edit that file by hand; commit it with the contract.
- **The breaking check**: `npm run api:check` refuses a change to the spec, compared with `origin/main`, that
  removes a call, a field the server sends, an event kind or field, or a value an app sends, makes a sent
  field possibly missing, or makes apps send something new. New calls, fields, values and event kinds pass
  (it notes them: apps must ignore what they do not know). `tests/api-contract.mjs` runs it in `npm test`.
  A change no app can notice may be listed, word for word, in `api/accepted-breaking.md`; never list one that
  takes something from an app.
- **Routes**: `tests/app-routes.mjs` also checks that every call in the contract is a server route.

Areas in the contract so far: the bot list, chat rows, sending, reactions, stop, side chats (list, start,
rename, delete, undo), approval cards, question cards, tasks (list, edit, delete, undo), routines, the
Needs you board and Pages. Add an area by moving its calls into the contract, then switching the apps'
functions and the server's handlers to `call` and `answer`.

## Minimum app version

`server/src/app-support.ts` says which oldest Android and Windows app the server still works with
(`MIN_APP`), each with the reason beside it. `GET /api/app-support` answers it without a sign-in. An Android
app older than its minimum shows a bar ("This app is too old for your server", with an Update button when
`ANDROID_UPDATE_URL` is set); the Windows app shows the same in its window, read from its browser's user
agent, and points to Check for updates. Raise a minimum only when a change really needs it, never lower one.
A call or field that only apps below the minimum use may then be retired.

## Still to come

1. **More areas** in the contract, the rest of what the phone calls first. The phone's chat rows then read
   their body by kind, as the web does (today `mobile/src/api.ts` keeps `Row.body` loose).
