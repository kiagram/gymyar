# The GymYar project site

Source of the marketing site — plain hand-written HTML/CSS/JS, no build step, served by
nginx. Three pages in each of two languages, one stylesheet, one small script.

## Where it sits

This is the front door, and it shares an origin with the application:

```
/          this folder                      the pitch, in Persian
/en/       en/                              the same pitch, in English
/app/      apps/client's build output       the app itself
/api/      proxied to the api container     the backend
```

**Persian is on the root, not under a prefix.** Iran is this project's market, so the page a
visitor gets before they choose anything is the one the site is actually for. English is a
mirror one level down, not an afterthought — the two are the same site — but only one of them
can be the address people are handed, and it is not the English one.

That is a change: Persian used to be at `/fa/` and English on the root. `infra/web/nginx.conf`
rewrites `/fa/...` → `/...` permanently, so every old Persian link still resolves. The English
move cannot be redirected the same way — `/docs.html` is a live Persian address now — so an old
English link lands on the Persian page of the same name, where the nav's language switch is the
way back. `infra/scripts/smoke.sh` asserts all of this: which language is on the root, that
`/en/` is English, and that `/fa/docs.html` still 301s.

One origin is not tidiness. Passkeys are bound to one, session cookies are scoped to one, and
the app reaching `/api` with no CORS anywhere is a consequence of `infra/web/nginx.conf`
rather than of any code. It also means "Open the app" is a link and not a second deployment:
a visitor who signs in at `/app/` is looking at the same Postgres this site quotes its numbers
from.

The client is built with `base: './'` and routes through a HashRouter, so nothing in it knows
it is one level down. Moving it was a line in nginx.conf.

Not in this folder (added at deploy time by `infra/web/Dockerfile`, and gitignored here):

- `assets/` — the five phone screenshots plus `banner.png`, and `assets/fa/` with the Persian
  set that the root `index.html` points at. Both come from `../../assets/screenshots/`.
  **Not `img/`**: the exercise media volume is mounted at `/img`, and a folder of that name
  here would shadow 1,324 exercise images with five screenshots.
- `icon-180.png` / `icon-512.png` — copied from `../client/public/`, so the browser tab,
  the home-screen icon and the app itself all match
- `brand/` — `gymyar-mark.svg` and `gymyar-lockup.svg` from `../../logo/`, the same vectors the
  store assets are cut from. `.dockerignore` excludes `logo` and then lets `logo/*.svg` back
  through for exactly this.
- `fonts/` — `vazirmatn-variable.woff2` and its `OFL.txt`, from
  `../client/src/assets/fonts/`, so the site and the app are set in one file rather than two
- `GymYar.apk` — the signed release build, if you serve it directly (see `docs/RELEASING.md`)

A page renders without any of these — it just renders wrong, and quietly. That is why the smoke
test asks for the font and the mark by URL rather than trusting the HTML's status code.

## The counters are real

`#instance` on both home pages is the one section whose contents come out of the database. It
ships with the `hidden` attribute; `site.js` fetches `/api/public/stats` and removes it only
once an instance has answered with at least one logged session. So the same files serve
correctly with no backend behind them at all — the section simply is not there.

The endpoint takes no account and returns counts and one sum: accounts, coaches, finished
sessions, working sets, tonnage, library size. Warm-ups and unfinished sessions are excluded,
because a number on a landing page that counts them is flattering itself. An instance that
would rather not publish any of it sets `PUBLIC_STATS=off` and the route stops existing.

## sw.js is a tombstone

Not a service worker — an uninstaller. The app used to be served at `/` and registered a
worker scoped to the whole origin; every browser that opened this instance before the move
still has one, and it would keep answering for `/` with a cached copy of the application.
`sw.js` here deletes the origin's caches, unregisters itself and reloads the page. Nothing
registers it; it is reached only by a browser that already has the old one.

## The design

Editorial, not a landing page: ivory paper, onyx ink, emerald used the way a printer uses a
second colour. Three decisions carry it, and each replaced something that made the old sheet
read as generated.

- **Hairlines, not cards.** `.hair` is a grid whose 1px `gap` shows the container's own colour
  through, so every rule between two cells is exactly one line, and it is ruled top and bottom
  but open at the sides — a table in a book. There is one border radius on this site, 2px, and
  it is on buttons.
- **A ruled index, not a wall of emoji.** Fifteen features as fifteen rounded boxes with a
  pictograph apiece is the shape of every generated page; as an `<ol class="index">` it is a
  page of a manual, which is what it is. The six coaching notes that do carry a glyph carry an
  inline SVG drawn in the brand's own emerald — an emoji is drawn by the *reader's* machine, so
  it is a different shape and a different colour on every platform and none of those colours is
  ours.
- **One typeface, four sizes.** See below.

Every section is a `.band`: a rule across the page, an index and a label in the margin column,
the argument in the wide one. The margin column is what makes the page read as set rather than
stacked, and it is the first thing to go on a phone. One band per page is `.slab` — full bleed,
onyx, ivory type — the way a printed page usually has one black plate.

## Colour

Three brand values and two greys between them. `--emerald` is the brand, `#1FA774`, and it is
**2.7:1 on ivory** — so it draws lines and the mark and never carries a word. `--emerald-ink`
`#12694A` is the same colour taken deep enough to be read: 5.9:1 on ivory, 6.7:1 under white,
and it is the only one allowed on text or behind a label. Swapping the two is how this page
would lose its contrast silently.

Onyx on ivory is 17.1:1, `--ink-2` is 7.6:1 and `--ink-3` — the smallest labels on the page —
is 5.2:1. There is nothing on this site below AA.

There is a dark counterpart under `prefers-color-scheme: dark`. It is not a second design: the
same tokens with paper and ink exchanged, which is what keeps it from drifting. Brand emerald
reads at 6.4:1 on onyx, so on that side it is the accent ink and the deep green is unused.

## The typeface

**Vazirmatn, self-hosted, one variable file for both scripts.** The old stylesheet *named*
Vazirmatn and shipped nothing, which on a Persian-first site means the primary language falls
through to whatever Arabic face the visitor's machine happens to carry — a different typeface
per visitor, and no way to set a type scale against any of them. Naming a font is not shipping
one; this is the same lesson `apps/client/src/index.css` records.

It is served from this origin rather than from Google Fonts, which is not reachable from Iran.
There is no second Latin face because the site mixes scripts inside single lines (AGPL,
`docker compose`, ۱٬۳۲۴) and a Latin-first stack sets each half of such a line differently.

`<link rel="preload">` in each page's head is load-bearing on a slow connection: without it the
font is discovered only when the stylesheet parses, and the Persian text is chosen, measured and
painted twice.

## The two languages

`en/` is a full mirror — `en/index.html`, `en/docs.html`, `en/about.html` — not a translation
layer. There is no build step and no runtime i18n here, so the alternative to duplicated files
is JavaScript that swaps strings after load, which costs one language its indexability and its
`lang`.

- **The Persian is written in Persian, not translated from the English.** Same claims, same
  structure, same section ids — but the sentences are built to work in Persian. This is the rule
  `docs/store/listing.fa.md` already set for the store copy.
- **`<html lang="fa" dir="rtl">` is the whole RTL mechanism.** `styles.css` is shared and uses
  logical properties (`margin-inline-start`, `inset-inline-start`, `border-inline-start`), so
  it mirrors on its own. There is no second stylesheet and there should never be one.
- **The type scale's negative tracking is reset for Persian**, in one rule at the foot of the
  sheet. The correct amount for cursive Persian is not a smaller number, it is none — tracking
  tightens joins that already touch. Do not replace that reset with per-step Persian values.
- **Latin inside Persian prose needs isolating.** `3.0-or-later` under a Persian caption is
  reordered by the bidi algorithm and reads `or-later-3.0`. Code and `.figure b` are forced back
  to LTR in the stylesheet; anything else Latin should be written in Persian instead.
- **Numbers are Persian digits in prose** (`۱٬۳۲۴ حرکت`), and Latin in code, versions and
  licence names.
- **Every page links to its counterpart** — `hreflang` in the head, a switch in the nav and in
  the footer. Anchors match on both sides, so `/#pricing` and `/en/#pricing` are the same place
  in two languages. `x-default` points at `/en/`: that address is for a visitor neither language
  matches, and they read English.

Changing one language's page and not the other is the failure mode here. The structures are
identical on purpose: same ids, same section order, same number of cells.

## Before deploying

- ~~**Set the domain.**~~ Done: both home pages carry `https://gymyar.kiarash.tech/` in their
  Open Graph `og:url` and `og:image` and in the JSON-LD `url`, with `/en/` on the English side.
  Open Graph needs absolute URLs, so these cannot be made relative — if the site ever moves,
  they have to be edited again, in both languages.
- ~~**Set the repository.**~~ Done: `REPO` in `site.js` points at `github.com/kiagram/gymyar`,
  so the `data-repo` links are live — nav, footer, and the open-source button row, in both
  languages. Paths use `/blob/HEAD/`, which resolves to the default branch; `/blob/main/` would
  serve openGym's files, since `main` is the import.
- **The screenshots are current.** `../../assets/screenshots/` holds the English set and `fa/`
  the Persian one, captured off the demo seed at 1170×2532 — the dimensions this site's `<img>`
  tags already declare. **They are still the pre-GYMYAR red build.** Retake them with
  `node infra/scripts/screenshots.mjs` (add `--fa` for the Persian set) against an instance on
  the current emerald UI; the hero on the Persian page is the first thing a visitor sees and it
  is currently the wrong brand.
- **Link the APK.** The download panel currently points at the install instructions rather than
  at a file. Point it at the APK once there is a signed one to serve.
- **The app answers at `/app/`.** `infra/scripts/smoke.sh` checks this against a running compose
  stack, along with the language on the root, the `/fa/` redirect, the brand assets, the
  screenshots having shipped, and a wrong path being a 404 rather than the app.
