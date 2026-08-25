# The GymBuddy project site

Source of the marketing site — plain hand-written HTML/CSS/JS, no build step, served by
nginx. Three pages (`index`, `docs`, `about`), one stylesheet, one small script — and a
Persian mirror of all three under `fa/`.

Not in this folder (added at deploy time):

- `img/` — the five phone screenshots plus `banner.png`, and `img/fa/` with the Persian
  set that `fa/index.html` points at. Both come from `../../assets/screenshots/`.
- `icon-180.png` / `icon-512.png` — copied from `../client/public/`, so the browser tab,
  the home-screen icon and the app itself all match
- `GymBuddy.apk` — the signed release build, if you serve it directly (see `docs/RELEASING.md`)

## Before deploying

- **Set the domain.** `index.html` carries `https://gymbuddy.example/` in its Open Graph
  `og:url` and `og:image` and in the JSON-LD `url`. Open Graph needs absolute URLs, so these
  cannot be made relative — they have to be edited.
- ~~**Set the repository.**~~ Done: `REPO` in `site.js` points at
  `github.com/kiagram/gymbuddy`, so the `data-repo` links are live — nav, footer, and the
  open-source button row, in both languages. Paths use `/blob/HEAD/`, which resolves to the
  default branch; `/blob/main/` would serve openGym's files, since `main` is the import.
- **The screenshots are current.** `../../assets/screenshots/` holds the English set and
  `fa/` the Persian one, captured off the demo seed at 1170×2532 — the dimensions this
  site's `<img>` tags already declare. Retake them after any UI change with
  `node infra/scripts/screenshots.mjs` (add `--fa` for the Persian set).
- **Link the APK.** The download card in `index.html` currently points at the install
  instructions rather than at a file. Point it at the APK once there is a signed one to serve.

## Colour

The accent is GymBuddy red, `#e63935`, matching `--brand` in the app's `index.css`.
Filled controls use `--acc-fill: #d42e2a` instead: white text on the brand red is 4.2:1,
which misses AA, and one step darker clears it at 5:1 while reading as the same colour.

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
