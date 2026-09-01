# The GymYar project site

Source of the marketing site — plain hand-written HTML/CSS/JS, no build step, served by
nginx. Three pages (`index`, `docs`, `about`), one stylesheet, one small script — and a
Persian mirror of all three under `fa/`.

## Where it sits

This is the front door, and it shares an origin with the application:

```
/          this folder                      the pitch
/app/      apps/client's build output       the app itself
/api/      proxied to the api container     the backend
```

One origin is not tidiness. Passkeys are bound to one, session cookies are scoped to one, and
the app reaching `/api` with no CORS anywhere is a consequence of `infra/web/nginx.conf`
rather than of any code. It also means "Open the app" is a link and not a second deployment:
a visitor who signs in at `/app/` is looking at the same Postgres this site quotes its numbers
from.

The client is built with `base: './'` and routes through a HashRouter, so nothing in it knows
it is one level down. Moving it was a line in nginx.conf.

Not in this folder (added at deploy time by `infra/web/Dockerfile`):

- `assets/` — the five phone screenshots plus `banner.png`, and `assets/fa/` with the Persian
  set that `fa/index.html` points at. Both come from `../../assets/screenshots/`.
  **Not `img/`**: the exercise media volume is mounted at `/img`, and a folder of that name
  here would shadow 1,324 exercise images with five screenshots.
- `icon-180.png` / `icon-512.png` — copied from `../client/public/`, so the browser tab,
  the home-screen icon and the app itself all match
- `GymYar.apk` — the signed release build, if you serve it directly (see `docs/RELEASING.md`)

`.dockerignore` excludes the repository's top-level `assets/` and then lets
`assets/screenshots` and `assets/banner.png` back through for exactly this. A pattern like
`**/assets` added there later would produce a site with no pictures on it and no error.

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

## Before deploying

- **Set the domain.** `index.html` carries `https://gymyar.example/` in its Open Graph
  `og:url` and `og:image` and in the JSON-LD `url`. Open Graph needs absolute URLs, so these
  cannot be made relative — they have to be edited. Both languages carry their own.
- ~~**Set the repository.**~~ Done: `REPO` in `site.js` points at
  `github.com/kiagram/gymyar`, so the `data-repo` links are live — nav, footer, and the
  open-source button row, in both languages. Paths use `/blob/HEAD/`, which resolves to the
  default branch; `/blob/main/` would serve openGym's files, since `main` is the import.
- **The screenshots are current.** `../../assets/screenshots/` holds the English set and
  `fa/` the Persian one, captured off the demo seed at 1170×2532 — the dimensions this
  site's `<img>` tags already declare. Retake them after any UI change with
  `node infra/scripts/screenshots.mjs` (add `--fa` for the Persian set).
- **Link the APK.** The download card in `index.html` currently points at the install
  instructions rather than at a file. Point it at the APK once there is a signed one to serve.
- **The app answers at `/app/`.** `infra/scripts/smoke.sh` checks this against a running
  compose stack, along with the site being at `/`, `/app` redirecting to `/app/`, a wrong path
  being a 404 rather than the app, and the screenshots having shipped.

## Colour

The accent is GYMYAR emerald, `#1fa774`, matching `--brand` in the app's `index.css`.
Filled controls use `--acc-fill: #17835b` instead: white text on the brand emerald is 3.1:1,
which misses AA, and one step darker clears it at 4.7:1 while reading as the same colour.

## The Persian site

`fa/` is a full mirror — `fa/index.html`, `fa/docs.html`, `fa/about.html` — not a translation
layer. There is no build step and no runtime i18n on this site, so the alternative to
duplicated files is JavaScript that swaps strings after load, which costs the Persian pages
their indexability and their `lang`. Persian is the primary market; its pages should be as
real as the English ones.

- **It is written in Persian, not translated from the English.** Same claims, same structure,
  same section ids — but the sentences are built to work in Persian. This is the rule
  `docs/store/listing.fa.md` already set for the store copy.
- **`<html lang="fa" dir="rtl">` is the whole RTL mechanism.** `styles.css` is shared and uses
  logical properties (`margin-inline-start`, `inset-inline-start`, `border-inline-start`), so
  it mirrors on its own. There is no `fa/styles.css` and there should never be one: a second
  stylesheet is two things to keep in step.
- **Numbers are Persian digits in prose** (`۱٬۳۲۴ حرکت`), and Latin in code, versions and
  licence names. `:lang(fa) code` is forced back to LTR — `docker compose up -d` reversed is
  not a command anyone can run.
- **No webfont.** Google Fonts is not reachable from Iran, and every platform that matters
  ships a Persian face. The stack names Vazirmatn first for the machines that have it.
- **Every page links to its counterpart** — `hreflang` in the head, a switch in the nav and in
  the footer. Anchors match on both sides, so `/#pricing` and `/fa/#pricing` are the same
  place in two languages.

Changing one language's page and not the other is the failure mode here. The structures are
identical on purpose: same ids, same section order, same number of cards.
