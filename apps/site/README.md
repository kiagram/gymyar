# The GymBuddy project site

Source of the marketing site — plain hand-written HTML/CSS/JS, no build step, served by
nginx. Three pages (`index`, `docs`, `about`), one stylesheet, one small script.

Not in this folder (added at deploy time):

- `img/` — the five phone screenshots plus `banner.png`
- `icon-180.png` / `icon-512.png` — copied from `../client/public/`, so the browser tab,
  the home-screen icon and the app itself all match
- `GymBuddy.apk` — the signed release build, if you serve it directly (see `docs/RELEASING.md`)

## Before deploying

- **Set the domain.** `index.html` carries `https://gymbuddy.example/` in its Open Graph
  `og:url` and `og:image` and in the JSON-LD `url`. Open Graph needs absolute URLs, so these
  cannot be made relative — they have to be edited.
- **Set the repository.** `REPO` at the top of `site.js` is empty, and every link marked
  `data-repo` stays hidden while it is. Fill it in once the repo is public
  (`docs/PUBLISHING.md`) and they appear — nav, footer, and the open-source button row.
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
