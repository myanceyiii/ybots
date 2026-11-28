# Saved logins

A person saves a site's username and password once. When a Bot's browser reaches that site's sign-in page,
the Bot asks on a card, the person presses **Sign in**, and the server types the saved login into the page.
The Bot never sees the values. Built on the secure input card ([browser-cards.md](browser-cards.md)).

## Design

| Question | Answer |
|---|---|
| Where is it kept | `vault_logins` in the app's database. The username and password are sealed with AES-256-GCM (Node `crypto`). The key is `vault/key` next to the database (or `VAULT_KEY_FILE`), made on the first save, mode 600, dir 700. Each seal binds the row's id, owner and site, so a sealed value copied to another row or site does not open. Database snapshots and exports hold only sealed values. |
| Who sees it | Each login belongs to one person: the account's owner, or a scoped family member (`SCOPED_PEOPLE`). Only that person lists, changes or deletes it, and only they can press Sign in on its card. There is no "show password" anywhere: change it or delete it. |
| Which Bots may use it | A scoped person's Bot (Robin) uses only that person's logins; the owner's logins are for the owner's other Bots. Each login can be limited to some Bots. Siloed Bots (Sheldon) never use the vault. |
| How a Bot uses it | `list_saved_logins` gives site, label and an opaque id (no usernames). `use_saved_login` reads the page's real origin and fields from the browser (never the Bot's or the page's word), finds a saved login for that site (or its subdomains), and puts a card in the chat. |
| The card | Names the page's host in large type, the saved login's label and a username hint (`al•••@example.com`), the fields it will fill and the Bot's reason. Sign in only (no Always allow), only from the apps (never a notification), only by a person (never a script session), only by the login's owner, bound to the card's digest (login, origin, fields, frame, page). Deny types nothing. |
| The fill | After Sign in the server re-checks the page and frame origin, then types into the exact fields with DevTools `Input.insertText`. Both values are added to the salted-hash scrub list, so a later browser result that echoes them is masked. The Bot hears only which fields were filled. |
| Refused pages | Not https (plain http only on this machine or the home network); a page on another site; fields in a frame from another site. |
| Saving | Settings › Saved logins on web, Windows and Android (add, change, limit to Bots, delete), and "Save to my logins" on a secure input card for passwords, usernames and emails, saved only after the value went into the page, for the person who typed it. |
| Mail, calendar, money | Logins for those sites are marked "Mail, calendar or money site" (guessed from the address, editable). The card warns, and the Bot is told, that a failed connected app is reported, never swapped for the browser. |

## What stays out of reach

Values are never returned by any route, put on a card row, logged, given to a Bot, or written to memory.
Tests (`tests/vault-e2e.mjs`) check the database file, the chats and the server log for every value.

## Limits

- The key sits on the same machine as the database: this protects copies of the database (snapshots,
  exports, a stolen file), not a person with root on the server.
- Bots with terminal access on the same machine run as root (see SECURITY.md); the vault does not change that.
- Only the Bots' managed Chrome is filled, like the secure input card.

## Sources

- OpenBot docs (`docs/how-openbot-works.md` "Your vault", `docs/approvals.md` credentials) at f681239: the vault is
  the person's, Bots never see it, credential changes stay with the person.
- Merit-Systems/OpenInstinct (MIT): opaque handles in `list_vault` / `fill_from_vault`, origin from the browser.
- Skipped: bitwarden/mcp-server (GPL-3.0, gives the agent the secrets), Vaultwarden (AGPL, a separate service to run and unlock).
