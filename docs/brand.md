# Look and brand: "Signal"

The README, the docs diagrams and the repository's social preview share one small design language. The
idea: a team of agents joined at one point. Everything here was made for the project (MIT); the fonts are
open-licensed (see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)).

## The mark

A **Y drawn as three agents joined at one point**: two nodes at the top, one at the bottom, lines meeting at
a small hole. The top-left node is lime; the others take the text colour.

- Keep clear space of at least one node's width around it. Don't rotate it, add eyes or faces, outline it
  or put it on a busy picture.
- Wordmark: "YBots" in Space Grotesk Bold, tracking -3%. One word, capital Y and B.
- App icon: the mark on ink (`#0E1116`), drawn in every size by `scripts/icons/build-icons.mjs` from
  `scripts/icons/design.mjs`.

## Colours

| Token | Dark | Light | Use |
|---|---|---|---|
| base | `#0E1116` | `#F6F7F9` | page and card background |
| surface | `#161B22` | `#FFFFFF` | boxes |
| raise | `#1C232D` | `#EEF1F5` | fields, quiet fills |
| line | `#2A313C` | `#DCE1E8` | borders, graph edges |
| text | `#E8ECF1` | `#0E1116` | text, the mark |
| muted | `#8B95A3` | `#5A6472` | labels, arrows |
| lime (accent) | `#C6F432` | `#C6F432` fill, `#4D6600` text | the one thing to look at: the approval step, the active bot |
| sky | `#5CC8FF` | `#1F8FD6` | people (the user's avatar), links |
| coral | `#FF7A59` | `#E4572E` | warnings, "experimental" |

Use lime once per picture. Text on lime is ink.

## Type

- **Space Grotesk** (700, 500): the wordmark and big titles.
- **Inter** (400 to 600): body text and box titles.
- **JetBrains Mono** (400, 600): labels in capitals with 6 to 10% tracking, code, sample data.

## Pictures

- **Diagrams**: rounded boxes (12 px), 1.5 px borders, muted arrows with small solid heads; the step that
  matters gets a lime border and a lime arrow. A dashed rounded box is a boundary ("your Linux machine").
- **Product pictures** are illustrations with sample data, not screenshots of a real install: the bot is
  **Robin**, the owner is **Alex**, addresses are at `example.com`. Avatars are plain circles with an
  initial: lime for a bot, sky for a person.
- Every picture comes in light and dark (`-light.svg`, `-dark.svg`), shown with a `<picture>` element that
  follows `prefers-color-scheme`.
- Text inside SVGs is turned into outlines, because GitHub shows SVGs as images that cannot load fonts.

## Files

| File | What |
|---|---|
| `assets/readme/banner-*.svg` | README banner |
| `assets/readme/app-*.svg` | the app, illustrated |
| `assets/readme/architecture-*.svg`, `approvals-*.svg` | diagrams |
| `assets/readme/divider.svg` | section divider |
| `assets/readme/social-preview.png` | 1280×640 social preview: upload it in the repository's Settings, under Social preview |

Change them in `scripts/brand/build-readme-art.mjs` and run it (instructions at the top of the file); the
outputs are committed. Badges use shields.io with `labelColor=0E1116` and a palette colour.
