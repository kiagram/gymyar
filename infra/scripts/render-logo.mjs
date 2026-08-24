/* Cut every raster icon the apps ship from the vectors in logo/.
 *
 * The identity lives in logo/*.svg and nowhere else. iOS, Android, the PWA and the favicon
 * are all output — twenty-odd files that no one edits by hand and that therefore cannot
 * drift apart. @capacitor/assets would do some of this, but it needs a working sharp build,
 * and it does not touch public/.
 *
 *   node infra/scripts/render-logo.mjs [--check]
 *
 * --check re-renders everything in memory and compares, for CI: it fails if a committed
 * file no longer matches its source SVG. The comparison is per-pixel with a tolerance,
 * not byte-for-byte — a PNG rendered by Chromium on Linux is not the same file as one
 * rendered on Windows, and a check that fails on the developer's operating system is a
 * check that gets deleted.
 *
 * Rendering goes through the same headless Chromium the e2e tests use — the one
 * rasteriser we already depend on.
 */
import { chromium } from 'playwright-core'
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const LOGO = join(ROOT, 'logo')
const CHECK = process.argv.includes('--check')

const ICON = 'gymbuddy-icon.svg'                 // rounded field — web, PWA, legacy launcher
const SQUARE = 'gymbuddy-icon-square.svg'        // square field — iOS masks it itself
const MASKABLE = 'gymbuddy-icon-maskable.svg'    // pulled-in mark — Android adaptive, maskable
const MARK = 'gymbuddy-mark-white.svg'           // mark alone — adaptive foreground layer

/* Android's adaptive layers are PNGs whose sizes were fixed when the project was
 * generated; read them off disk rather than restating the density table here. */
const androidRes = join(ROOT, 'apps/client/android/app/src/main/res')
const pngSize = file => {
  const b = readFileSync(file)
  return [b.readUInt32BE(16), b.readUInt32BE(20)]
}

const targets = []
const add = (src, out, w, h, opts = {}) =>
  targets.push({ src, out, w, h, shape: 'square', fill: 1, field: null, ...opts })

/* Android composites its adaptive layers inset by 16.7%, and then the launcher may crop the
 * result to a circle 66/108 across. The mark's own canvas is trimmed to the figure, so drawn
 * edge to edge it would lose its shoulders to that crop — the foreground layer gets drawn
 * smaller, leaving the figure's bounding circle inside the safe one. */
const ADAPTIVE_FILL = 0.74

/* The launch screen is the icon tile on the brand's off black, which is what the brand
 * system's own onboarding screens show. It is a layout, not artwork: a field and the icon
 * at a share of the shorter side, so it survives being centre-cropped to any device. */
const SPLASH_FIELD = '#0D0D0D'
/* Android has a splash per orientation, so the tile can take a generous share of the shorter
 * side. iOS has one square for every device: crop that to a 9:19.5 phone and only 46% of its
 * width survives, so the same share there would fill half the screen. It gets its own. */
const SPLASH_SHARE = 0.26
const SPLASH_SHARE_SQUARE = 0.14

const rel = p => p.slice(ROOT.length + 1).split(sep).join('/')

add(ICON, 'apps/client/public/icon-180.png', 180, 180)
add(ICON, 'apps/client/public/icon-512.png', 512, 512)
add(MASKABLE, 'apps/client/public/icon-maskable-512.png', 512, 512)
add(SQUARE, 'apps/client/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024, 1024)

for (const dir of readdirSync(androidRes).filter(d => d.startsWith('mipmap-') && d !== 'mipmap-anydpi-v26')) {
  const legacy = join(androidRes, dir, 'ic_launcher.png')
  const layer = join(androidRes, dir, 'ic_launcher_foreground.png')
  if (!existsSync(legacy) || !existsSync(layer)) continue
  const [ls] = pngSize(legacy), [as] = pngSize(layer)
  add(ICON, rel(legacy), ls, ls)
  add(ICON, rel(join(androidRes, dir, 'ic_launcher_round.png')), ls, ls, { shape: 'circle' })
  add(MARK, rel(layer), as, as, { fill: ADAPTIVE_FILL })
  add(SQUARE, rel(join(androidRes, dir, 'ic_launcher_background.png')), as, as)
}

/* Splash screens: every density and orientation Android was generated with, day and night
 * alike — the app is dark whichever way the system is set, and a light launch screen would
 * flash white before the first paint. Plus the one square iOS uses for everything. */
const splashes = readdirSync(androidRes)
  .filter(d => d.startsWith('drawable'))
  .map(d => join(androidRes, d, 'splash.png'))
  .filter(existsSync)
const iosSplash = join(ROOT, 'apps/client/ios/App/App/Assets.xcassets/Splash.imageset')
if (existsSync(iosSplash)) {
  for (const f of readdirSync(iosSplash).filter(f => f.endsWith('.png'))) splashes.push(join(iosSplash, f))
}
for (const file of splashes) {
  const [w, h] = pngSize(file)
  add(ICON, rel(file), w, h, { field: SPLASH_FIELD, fill: w === h ? SPLASH_SHARE_SQUARE : SPLASH_SHARE })
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] })
let stale = 0

/* Enough of a PNG reader to get pixels back out: 8-bit, non-interlaced, which is all
 * Chromium's screenshots ever are. */
const pixels = buf => {
  let p = 8, w = 0, h = 0, depth = 0, colour = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8)
    const body = buf.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); depth = body[8]; colour = body[9] }
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour]
  if (depth !== 8 || !channels) throw new Error(`unsupported PNG: depth ${depth}, colour type ${colour}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels, out = Buffer.alloc(h * stride)
  let row = 0, at = 0
  for (let y = 0; y < h; y++) {
    const filter = raw[at++]
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[row + x - channels] : 0
      const up = y > 0 ? out[row - stride + x] : 0
      const upLeft = x >= channels && y > 0 ? out[row - stride + x - channels] : 0
      let v = raw[at + x]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) {
        const est = left + up - upLeft
        const dl = Math.abs(est - left), du = Math.abs(est - up), dul = Math.abs(est - upLeft)
        v += dl <= du && dl <= dul ? left : du <= dul ? up : upLeft
      }
      out[row + x] = v & 255
    }
    at += stride
    row += stride
  }
  /* Widen to RGBA. Chromium writes a fully opaque icon without an alpha channel and a
   * rounded one with it, and those two are still comparable. */
  if (channels === 4) return { w, h, data: out }
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0, o = 0; o < rgba.length; i += channels, o += 4) {
    const grey = channels < 3
    rgba[o] = out[i]
    rgba[o + 1] = grey ? out[i] : out[i + 1]
    rgba[o + 2] = grey ? out[i] : out[i + 2]
    rgba[o + 3] = channels === 2 ? out[i + 1] : 255
  }
  return { w, h, data: rgba }
}

/* A pixel is "different" if any channel moved by more than a hair; the file is stale if
 * enough of them did. Platform antialiasing wobbles a rendered edge by a shade or two. */
const DELTA = 16, TOLERANCE = 0.005

const compare = (out, produced, binary) => {
  const path = join(ROOT, out)
  const current = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
  let same = current.equals(produced)
  let why = 'is stale'
  if (!same && !binary) {
    /* Text: git may have handed the working tree CRLF. */
    same = current.toString('utf8').replace(/\r\n/g, '\n') === produced.toString('utf8')
  }
  if (!same && binary && current.length) {
    try {
      const a = pixels(current), b = pixels(produced)
      if (a.w === b.w && a.h === b.h) {
        let off = 0
        for (let i = 0; i < a.data.length; i += 4) {
          for (let c = 0; c < 4; c++) {
            if (Math.abs(a.data[i + c] - b.data[i + c]) > DELTA) { off++; break }
          }
        }
        const share = off / (a.w * a.h)
        same = share <= TOLERANCE
        if (!same) why = `differs from logo/ in ${(share * 100).toFixed(1)}% of its pixels`
      } else why = `is ${a.w}×${a.h}, should be ${b.w}×${b.h}`
    } catch (e) { why = `could not be read: ${e.message}` }
  }
  if (same) return
  console.log(`  ✗ ${out} ${why}`)
  stale++
}

for (const { src, out, w, h, shape, fill, field } of targets) {
  const inner = Math.round(Math.min(w, h) * fill)
  const svg = readFileSync(join(LOGO, src), 'utf8').replace('<svg', `<svg width="${inner}" height="${inner}"`)
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  await page.setContent(`<!doctype html><style>
    html,body{margin:0;padding:0;background:transparent}
    #f{width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:${field || 'transparent'}${shape === 'circle' ? ';clip-path:circle(50%)' : ''}}
    svg{display:block}
  </style><div id=f>${svg}</div>`)
  const buf = await page.screenshot({ omitBackground: !field })
  await page.close()

  if (CHECK) compare(out, buf, true)
  else {
    writeFileSync(join(ROOT, out), buf)
    console.log(`  ✓ ${out}  ${w}×${h}  ← ${src}`)
  }
}

/* The PWA wants the vector too, and Capacitor reads its source icon from resources/. */
for (const [src, out] of [[ICON, 'apps/client/public/icon.svg'], [SQUARE, 'apps/client/resources/icon.svg']]) {
  const note = `<!-- Generated from logo/${src}. Edit that, then: node infra/scripts/render-logo.mjs -->\n`
  const copy = Buffer.from(note + readFileSync(join(LOGO, src), 'utf8'), 'utf8')
  if (CHECK) compare(out, copy, false)
  else {
    writeFileSync(join(ROOT, out), copy)
    console.log(`  ✓ ${out}  ← ${src}`)
  }
}

await browser.close()
if (CHECK && stale) { console.error(`\n${stale} icon(s) no longer match logo/. Run: node infra/scripts/render-logo.mjs`); process.exit(1) }
if (CHECK) console.log('  ✓ every icon matches logo/')
