/* Capture the product screenshots against a running demo stack.
 *
 *   node infra/scripts/screenshots.mjs [baseUrl] [outDir]
 *
 * Defaults to http://localhost:5173 and assets/screenshots/. Add --fa for the Persian set,
 * which is the one the store listings want alongside the English: it is the fastest way to
 * show the app is genuinely translated rather than machine-labelled, and it is the only way
 * to see that the layout actually mirrors.
 *
 * What it expects, in order:
 *
 *   docker compose up -d db        (or any Postgres in DATABASE_URL)
 *   npm run db:reset && npm run db:demo
 *   npm run api
 *   npm run dev
 *
 * It signs in as sam@gymbuddy.test — the demo client who shares every scope and has twelve
 * weeks of training behind them, so no screen comes out empty. A store will reject a set that
 * shows placeholder data, which is the whole reason to shoot against the seed rather than a
 * fresh account.
 *
 * Phone viewport at DPR 3 → 1170×2532, the size the listings are written for.
 *
 * NOTE ON THE MEDIA: the exercise images and animations are © Gym visual and are not licensed
 * for commercial use here — see NOTICE.md. Any screenshot showing an exercise demo inherits
 * that, so the library shot cannot go to a store until the media is licensed or replaced.
 */
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2).filter(a => a !== '--fa')
const FA = process.argv.includes('--fa')

const BASE = args[0] || 'http://localhost:5173'
const OUT = args[1] || resolve(ROOT, FA ? 'assets/screenshots/fa' : 'assets/screenshots')
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--no-sandbox'],
})

const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  locale: FA ? 'fa-IR' : 'en-GB',
  timezoneId: FA ? 'Asia/Tehran' : 'Europe/London',
})
const page = await ctx.newPage()

/* The locale files are keyed by the English string, so they double as a lookup for driving a
 * translated UI: ask for the English label and get whatever this run's language renders. Far
 * less brittle than pasting Persian literals in here, and it cannot drift from the app. */
const dict = FA
  ? (await import(new URL('../../apps/client/src/locales/fa.js', import.meta.url))).default
  : {}
const T = en => dict[en] || en

const problems = []
page.on('pageerror', e => problems.push('pageerror: ' + e.message))
page.on('console', m => {
  const t = m.text()
  // /api/me before sign-in is a 401 by design — it is how the app asks "am I signed in?"
  if (m.type() === 'error' && !/401/.test(t)) problems.push(t.slice(0, 160))
})

const shot = async (name, settle = 900) => {
  await page.waitForTimeout(settle)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ✓ ${name}.png`)
}
/* Sheets survive a hash change — the router moves underneath them — so an exercise detail left
 * open in one step lands on top of the next step's screen. There is no Escape handler; they
 * close on their backdrop. The backdrop is full-screen but the sheet covers its middle, so a
 * normal click on it — even a forced one — dispatches at the centre and hits the sheet instead.
 * Clicking the strip along the top edge is the part actually exposed. A sheet opened from a
 * sheet is a stack, hence the loop. */
const dismiss = async () => {
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('.mback').count())) break
    await page.mouse.click(page.viewportSize().width / 2, 8)
    await page.waitForTimeout(400)
  }
}
const go = async (hash, settle = 1600) => {
  await dismiss()
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(settle)
}

console.log(`capturing ${FA ? 'fa' : 'en'} from ${BASE} → ${OUT}`)

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await page.getByRole('button', { name: /email and password/i }).click()
await page.getByPlaceholder('Email').fill('sam@gymbuddy.test')
await page.getByPlaceholder('Password').fill('gymbuddy-demo-1')
await page.getByRole('button', { name: /^Sign in$/ }).click()
await page.waitForTimeout(3500)
console.log('  signed in as sam@gymbuddy.test')

if (FA) {
  /* The UI language is a per-account setting, so the browser's locale alone does not touch it.
   * It is not a <select> either — long option lists open the app's own sheet, so this is two
   * taps: the Language row, then فارسی in the sheet it opens. */
  await go('/settings', 1600)
  await page.getByText('Language', { exact: true }).first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: 'فارسی' }).first().click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(2600)

  const rtl = await page.evaluate(() => document.documentElement.getAttribute('dir'))
  if (rtl !== 'rtl') throw new Error(`language did not switch — dir is ${rtl ?? 'unset'}, expected rtl`)
  console.log('  switched to فارسی, layout mirrored')
}

await go('/home')
await shot('home')

await go('/plan')
await shot('plan')

await go('/stats', 2600)          // the charts animate in
/* Muscle balance defaults to "Week", and on a Monday against the seed that is an empty state
 * front and centre. 90d is the same real data over a window that has something in it. */
const ninety = page.getByText(/^90d$/).first()
if (await ninety.count()) {
  await ninety.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1400)
}
await shot('stats', 1400)

await go('/library', 2200)
/* Search first: the unfiltered list starts at "3/4 Sit-Up", which is a poor advertisement for
 * a 1,324-exercise library. Open a lift people recognise instead. */
// By element, not by placeholder: the placeholder is translated, and this has to work in fa.
const search = page.locator('input.input').first()
if (await search.count()) {
  await search.fill('barbell bench press')
  await page.waitForTimeout(1800)
}
const thumb = page.locator('img').first()
if (await thumb.count()) {
  await thumb.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(2800)
}
await shot('library', 1200)

/* LAST, deliberately: starting a session puts a rest timer over every screen and turns the
 * tab bar's Start button into Resume, so anything captured afterwards carries a workout it
 * is not about. This shot leaves state behind; nothing follows it.
 *
 * A session in progress, with the rest timer running — the one screen that shows what using
 * the app actually feels like, and the first shot in the listing spec. Checking off a set is
 * what starts the rest countdown, so the set has to be logged before the shot is taken. */
await go('/workout', 2000)
// t('Start {0}', routineName) — take the template's own text up to the placeholder.
const startLabel = T('Start {0}').replace('{0}', '').trim()
const startBtn = page.getByRole('button', { name: new RegExp(startLabel, 'i') }).first()
if (await startBtn.count()) {
  await startBtn.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1600)
}
/* Starting a session opens the body-weight check-in first — it is asked before every workout
 * so the curve stays honest. Accept it at the seeded value rather than dismissing it, so the
 * run goes through the path a real session takes. */
const checkIn = page.getByRole('button', { name: T('Save & start workout'), exact: true }).first()
if (await checkIn.count()) {
  await checkIn.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(2200)
}
const firstSet = page.locator('[role="checkbox"]').first()
if (await firstSet.count()) {
  await firstSet.click({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(1200)          // let the rest timer come up and start counting
}
await shot('workout', 800)

console.log(problems.length ? `\n${problems.length} console/page problem(s):` : '\nno console errors')
for (const p of problems.slice(0, 8)) console.log('  ! ' + p)

await ctx.close()
await browser.close()
