/* Browser end-to-end test: drives the real UI against a real API and a real database.
 *
 * This exists because three bugs got through every other layer and only showed up here.
 * Postgres hands the server `Date` objects, so server-side tests never saw the ISO *strings*
 * JSON turns them into — and the client was keying an entire training history off timestamps
 * where it expected calendar days. Nothing but a round trip through a browser catches that.
 *
 * Run against a stack that is already up:
 *   node infra/scripts/e2e.mjs [baseUrl]      # default http://127.0.0.1:5173
 *
 * Expects the demo seed (`SEED_DEMO=1`) and a database reset beforehand — it accepts a
 * proposal, which is not something you can do twice.
 */
import { chromium } from 'playwright-core'

const BASE = process.argv[2] || process.env.E2E_BASE || 'http://127.0.0.1:5173'
// Honour a preinstalled browser when there is one; otherwise let playwright find its own.
const EXECUTABLE = process.env.CHROMIUM_PATH || undefined
const SHOTS = process.env.E2E_SHOTS || '/tmp'
const browser = await chromium.launch({ executablePath: EXECUTABLE, args: ['--no-sandbox'] })
let failures = 0
const check = (ok, what) => { console.log(`${ok ? '  ✓' : '  ✗'} ${what}`); if (!ok) failures++ }

const newPage = async () => {
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push('pageerror: ' + e.message))
  page.on('console', m => {
    const txt = m.text()
    // /api/me before sign-in is a 401 by design — that is how the app asks "am I signed in?"
    if (m.type() === 'error' && !/401/.test(txt)) errors.push(txt.slice(0, 200))
  })
  return { ctx, page, errors }
}
const signIn = async (page, email) => {
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.getByRole('button', { name: /email and password/i }).click()
  await page.getByPlaceholder('Email').fill(email)
  await page.getByPlaceholder('Password').fill('gymbuddy-demo-1')
  await page.getByRole('button', { name: /^Sign in$/ }).click()
  await page.waitForTimeout(3500)
}

console.log('coach@gymbuddy.test')
{
  const { ctx, page, errors } = await newPage()
  await signIn(page, 'coach@gymbuddy.test')
  await page.goto(BASE + '/#/coach', { waitUntil: 'networkidle' }); await page.waitForTimeout(1800)
  const roster = await page.textContent('body')
  check(/Sam Okonkwo/.test(roster) && /Ava Lindqvist/.test(roster) && /Theo Marsh/.test(roster), 'roster lists all three clients')
  check(/%/.test(roster), 'adherence percentages render')
  check(/days ago|today|yesterday|never/.test(roster), 'last-trained rendered')
  await page.screenshot({ path: `${SHOTS}/shot-coach-roster.png`, fullPage: true })

  await page.getByText('Sam Okonkwo').first().click(); await page.waitForTimeout(2000)
  const detail = await page.textContent('body')
  check(/Programmes/.test(detail) && /Recent sessions/.test(detail) && /Body weight/.test(detail), 'all three shared sections render')
  check(/Waiting on them/.test(detail), 'the open proposal is shown')
  check(!/Invalid Date|NaN|undefined/.test(detail), 'no broken values on the client detail screen')
  check(/Sam Okonkwo/.test(detail), 'the screen is headed by the client\'s name')
  await page.screenshot({ path: `${SHOTS}/shot-coach-client.png`, fullPage: true })
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

console.log('\ntheo@gymbuddy.test — programmes only')
{
  const { ctx, page, errors } = await newPage()
  await signIn(page, 'coach@gymbuddy.test')
  await page.goto(BASE + '/#/coach', { waitUntil: 'networkidle' }); await page.waitForTimeout(1500)
  await page.getByText('Theo Marsh').first().click(); await page.waitForTimeout(2000)
  const detail = await page.textContent('body')
  check(/Not shared/.test(detail), 'unshared sections say so rather than vanishing')
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

console.log('\nsam@gymbuddy.test')
{
  const { ctx, page, errors } = await newPage()
  await signIn(page, 'sam@gymbuddy.test')
  const local = await page.evaluate(() => {
    const S = JSON.parse(localStorage.getItem('gym_state_v1') || '{}')
    return { workouts: S.workouts?.length, d: S.workouts?.[0]?.d, cursor: localStorage.getItem('gym_sync_cursor') }
  })
  check(local.workouts > 30, `training history synced (${local.workouts} sessions)`)
  check(/^\d{4}-\d{2}-\d{2}$/.test(local.d || ''), `workout dates are calendar days (${local.d})`)

  await page.goto(BASE + '/#/stats', { waitUntil: 'networkidle' }); await page.waitForTimeout(2500)
  const stats = await page.textContent('body')
  check(/Workouts\s*35/.test(stats.replace(/\s+/g, ' ')), 'stats counts the synced sessions')
  check(!/No workouts in this period yet/.test(stats), 'muscle balance finds this week\'s training')
  await page.screenshot({ path: `${SHOTS}/shot-client-stats.png`, fullPage: true })

  await page.goto(BASE + '/#/home', { waitUntil: 'networkidle' }); await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOTS}/shot-client-home.png`, fullPage: true })

  await page.goto(BASE + '/#/coaching', { waitUntil: 'networkidle' }); await page.waitForTimeout(1800)
  const coaching = await page.textContent('body')
  check(/Waiting for you/.test(coaching) && /Kim Alvarez/.test(coaching), 'proposal inbox shows the coach\'s proposal')
  await page.screenshot({ path: `${SHOTS}/shot-client-coaching.png`, fullPage: true })

  await page.locator('.lrow.tap').first().click(); await page.waitForTimeout(1200)
  await page.screenshot({ path: `${SHOTS}/shot-client-proposal.png`, fullPage: true })
  const sheet = await page.textContent('body')
  check(/Accept/.test(sheet) && /Decline/.test(sheet), 'proposal sheet offers both answers')
  check(!/Invalid Date/.test(sheet), 'proposal date renders')

  await page.getByRole('button', { name: /^Accept$/ }).click(); await page.waitForTimeout(3500)
  const after = await page.textContent('body')
  check(!/Waiting for you/.test(after), 'inbox clears after accepting')

  await page.goto(BASE + '/#/plan', { waitUntil: 'networkidle' }); await page.waitForTimeout(2000)
  await page.screenshot({ path: `${SHOTS}/shot-client-plan.png`, fullPage: true })
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

await browser.close()
console.log(failures ? `\nFAILURES: ${failures}` : '\nall browser checks passed')
process.exit(failures ? 1 : 0)
