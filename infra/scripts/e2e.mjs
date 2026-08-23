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

/* ---------------- phase 4: building a plan, and drafting a change ---------------- */

console.log('\nplan builder')
{
  const { ctx, page, errors } = await newPage()
  await signIn(page, 'ava@gymbuddy.test')

  await page.goto(BASE + '/#/plan/build', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  const start = await page.textContent('body')
  check(/Build a plan/.test(start), 'the builder opens')
  check(/Describe it/.test(start) && /Choose/.test(start), 'both ways in are offered')
  await page.screenshot({ path: `${SHOTS}/shot-builder.png`, fullPage: true })

  await page.getByPlaceholder(/I want to get stronger/i)
    .fill('I want to get stronger, I can train 4 days a week for about an hour, and I have a barbell and dumbbells at home')
  await page.getByRole('button', { name: /Build me a plan/i }).click()
  await page.waitForTimeout(3000)

  const plan = await page.textContent('body')
  check(/Your plan/.test(plan), 'a plan comes back')
  check(/barbell/i.test(plan), 'it used the equipment that was described')
  check(/Upper|Lower|Full Body|Push|Pull/.test(plan), 'it named the sessions')
  check(!/undefined|NaN|\[object/.test(plan), 'nothing renders as undefined')
  await page.screenshot({ path: `${SHOTS}/shot-plan-draft.png`, fullPage: true })

  const before = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('gym_state_v1') || '{}').routines?.length ?? 0)

  await page.getByRole('button', { name: /Add this to my plan/i }).click()
  await page.waitForTimeout(3500)
  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('gym_state_v1') || '{}').routines?.length ?? 0)
  check(after > before, `the plan lands in their routines (${before} → ${after})`)
  await page.screenshot({ path: `${SHOTS}/shot-plan-applied.png`, fullPage: true })
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

console.log('\ntraining review')
{
  const { ctx, page, errors } = await newPage()
  await signIn(page, 'theo@gymbuddy.test')     // stopped training three weeks ago
  await page.goto(BASE + '/#/plan/build', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: /Review my training/i }).click()
  await page.waitForTimeout(2500)
  const review = await page.textContent('body')
  check(/last 4 weeks/i.test(review), 'the review renders')
  check(/Nothing logged for \d+ days/.test(review), 'it noticed he stopped turning up')
  await page.screenshot({ path: `${SHOTS}/shot-review.png`, fullPage: true })
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

console.log('\ncoach drafts a change')
{
  const { ctx, page, errors } = await newPage()
  await signIn(page, 'coach@gymbuddy.test')
  await page.goto(BASE + '/#/coach', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.getByText('Theo Marsh').first().click()
  await page.waitForTimeout(2000)
  const detail = await page.textContent('body')
  // Theo shares programmes only, so there is nothing honest to review
  check(!/Draft a change/.test(detail), 'no draft button without the workouts scope')

  await page.goto(BASE + '/#/coach', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1200)
  await page.getByText('Sam Okonkwo').first().click()
  await page.waitForTimeout(2000)
  check(/Draft a change/.test(await page.textContent('body')), 'the draft button is there for a client who shared')

  await page.getByText('Draft a change').first().click()
  await page.waitForTimeout(4000)
  const sheet = await page.textContent('body')
  check(/Propose a change/.test(sheet) || /Nothing to change/.test(sheet), 'drafting answered')
  await page.screenshot({ path: `${SHOTS}/shot-coach-draft.png`, fullPage: true })
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

console.log('\nlogging by typing')
{
  const { ctx, page, errors } = await newPage()
  await signIn(page, 'ava@gymbuddy.test')
  await page.goto(BASE + '/#/history', { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  await page.getByLabel(/Log by typing/i).click()
  await page.waitForTimeout(800)
  await page.locator('textarea').first().fill('bench 5x5 at 80\nplank 3x45s\nflurbulator 3x10')
  await page.getByRole('button', { name: /Read it back to me/i }).click()
  await page.waitForTimeout(2500)
  const read = await page.textContent('body')
  check(/bench press/i.test(read), 'it read the bench sets')
  check(/45s/.test(read), 'it read the plank as a hold')
  check(/Not saved/.test(read) && /flurbulator/.test(read), 'it said what it could not read')
  await page.screenshot({ path: `${SHOTS}/shot-textlog.png`, fullPage: true })

  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('gym_state_v1') || '{}').workouts?.length ?? 0)
  await page.getByRole('button', { name: /Save this session/i }).click()
  await page.waitForTimeout(2500)
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('gym_state_v1') || '{}').workouts?.length ?? 0)
  check(after === before + 1, `the session is saved once confirmed (${before} → ${after})`)
  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors[0] : ''}`)
  await ctx.close()
}

await browser.close()
console.log(failures ? `\nFAILURES: ${failures}` : '\nall browser checks passed')
process.exit(failures ? 1 : 0)
