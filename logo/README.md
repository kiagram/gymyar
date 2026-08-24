# GymBuddy — the mark

![The GymBuddy mark](gymbuddy-mark.svg)

The figure, arms crossed, drawn as a single silhouette with the muscle contours cut out of it
as negative space. On a red field it is white and the contours read as red lines; on paper it
is red and the contours read as white. One shape, two colourways, no second artwork.

It is a vector, traced from the app-icon artwork in this directory — not an upscaled render.
The contours hold at 512 and at 1024, and close up into a solid silhouette somewhere below
32px, which is the size at which every figure mark stops being a figure.

## Files

Everything the apps ship is cut from these. Edit the SVG, never the PNG.

| File | What it is | Where it goes |
|---|---|---|
| `gymbuddy-icon.svg` | Rounded red field, white figure | Web favicon, PWA, Android legacy launcher |
| `gymbuddy-icon-square.svg` | Square red field, white figure | iOS and Android, which apply their own mask |
| `gymbuddy-icon-maskable.svg` | Figure pulled in to the safe circle | `purpose: maskable`, Android adaptive |
| `gymbuddy-mark.svg` | Figure alone, GymBuddy red, transparent | Paper, light UI, README, print |
| `gymbuddy-mark-white.svg` | Figure alone, white, transparent | On red, on ink, adaptive foreground layer |
| `gymbuddy-mark-black.svg` | Figure alone, off black, transparent | One-colour use on light surfaces |

| `gymbuddy-hero.png` | The full lockup, 900px, transparent | README header, docs, marketing |
| `gymbuddy-hero-dark.png` | Same, wordmark lifted for dark pages | README header on a dark theme |

The mark files are trimmed to the figure — no invisible padding — so they scale predictably
wherever they are dropped. The icon files are 512×512 with the figure at 83% of the height,
which is the proportion the app-icon artwork uses.

Regenerate every raster after touching any of them:

```bash
node infra/scripts/render-logo.mjs
```

That writes `apps/client/public/`, the Android mipmaps, both platforms' splash screens and the
iOS app icon, and copies the vectors to `apps/client/public/icon.svg` and
`apps/client/resources/icon.svg`. CI runs the same script with `--check` and fails a build
where a committed PNG has drifted from its source.

**The launch screen** is not a separate drawing: it is `gymbuddy-icon.svg` centred on off
black, at 26% of the shorter side — 14% on the single square iOS uses for every device, where
cropping to a tall phone throws away more than half the width. That rule lives in the render
script. If the launch screen should ever carry the wordmark too, it needs the wordmark as a
vector first.

## Colour

| | Hex | |
|---|---|---|
| GymBuddy red | `#E63935` | Pantone 185 C · RGB 230 57 53 · CMYK 0 87 77 10 |
| Off black | `#0D0D0D` | Pantone Neutral Black C |
| Pure black | `#000000` | |
| White | `#FFFFFF` | |

The icon field is a vertical gradient, `#E63935` down to `#9E1512`. Everywhere else the red is
flat — the gradient belongs to the icon, not to the mark.

## Using it

- **On the red field the figure is white**, never red on red. On ink, white. On paper, red or
  off black — the contour lines are whatever is behind the figure, so the mark needs a plain
  surface to sit on. It does not go over photography.
- **Clear space** on every side is the width of the head. Nothing crosses it.
- **Smallest size** is 24px for the figure alone, 32px inside a field. Below that the contours
  fill in and it becomes a silhouette; that is expected, and it still reads.
- Do not recolour the contours, add a stroke, rotate, skew, or drop a shadow on it. Do not put
  the rounded field behind it anywhere except an app icon — the field is the icon, not the logo.

## Provenance, and what is still raster

The brand system in this directory is the source of everything above:

- The figure was traced from the **APP ICON SYSTEM** sheet (`…10_28_06 PM.png`), which carries
  the largest flat rendition of the mark.
- The palette is read off the **COLOR SYSTEM** sheet (`…10_29_05 PM.png`), not sampled by eye.
- Type, bilingual FA/EN pairing and the screen system are in the remaining sheets.

**The wordmark is not a vector yet.** `GYM BUDDY` and the `AI. TRAINING. RESULTS.` line exist
only as raster, so the lockups cannot be regenerated at arbitrary size the way the mark can.
The two `gymbuddy-hero-*.png` files are that lockup: the hero render (`…10_26_56 PM.png`,
which already carried its own transparency) trimmed to its content and scaled to 900px.

`gymbuddy-hero-dark.png` differs from the light one in the wordmark only. `GYM` and the
tagline are black, which disappears on a dark page, so their ink is inverted to white — the
figure is untouched, because its shading is neutral black as well and inverting that punches
holes in the torso. The README picks between them with `prefers-color-scheme`.

Anything that needs the lockup at a size these two cannot serve should set the words as live
text next to `gymbuddy-mark.svg`, until the wordmark is drawn as a vector.
