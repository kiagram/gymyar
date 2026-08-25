/* The purchase flow end to end over real routes, against a fake gateway and a real database.
 *
 * Two things are being tested here that neither the unit tests above nor the storage tests
 * below can reach: that money and entitlement meet correctly at the callback, and that the
 * gate lands on the coach and never on the client.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymbuddy/db'
import { setPaidThrough, ensureTrial, subscriptionFor } from '@gymbuddy/db/billing.js'
import { TRIAL_DAYS, GRACE_DAYS } from '@gymbuddy/domain/entitlement.js'

const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
const DAY = 86400000

let app
/** The gateway the routes see. Rewritten per test to make it answer what the test is about. */
let gw

/** A Zarinpal-shaped stand-in whose answers are the point of each test. */
const fakeGateway = () => ({
  name: 'zarinpal',
  currency: 'IRR',
  sandbox: true,
  request: vi.fn(async ({ amount }) => ({
    authority: 'A-' + Math.random().toString(36).slice(2, 10),
    startUrl: 'https://sandbox.zarinpal.com/pg/StartPay/A-x',
    raw: { amount }
  })),
  verify: vi.fn(async () => ({ ok: true, alreadyVerified: false, refId: 'R-' + Date.now(), code: 100, raw: {} })),
  unverified: vi.fn(async () => [])
})

/* The app is built once and holds whatever gateway it was handed, so what it is handed has to
 * be one stable object that forwards to the current `gw`. Passing `gw` itself would freeze
 * whichever fake existed at `beforeAll` — which is none of them — and quietly fall through to
 * a real Zarinpal terminal. */
const gatewayProxy = {
  name: 'zarinpal',
  get currency() { return gw.currency },
  get sandbox() { return gw.sandbox },
  request: (...a) => gw.request(...a),
  verify: (...a) => gw.verify(...a),
  unverified: (...a) => gw.unverified(...a)
}

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  // A gateway object alone does not make an instance billed — `billingEnabled()` reads the
  // environment, because whether coaching is paid for is a property of the deployment.
  process.env.ZARINPAL_MERCHANT_ID = 'test-merchant'
  app = await build({ databaseUrl: URL, rateLimit: false, gateway: gatewayProxy })
  const { seedExercises } = await import('@gymbuddy/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => {
  await db()`delete from users`
  gw = fakeGateway()
  process.env.ZARINPAL_MERCHANT_ID = 'test-merchant'
})
afterAll(async () => {
  delete process.env.ZARINPAL_MERCHANT_ID
  await app.close(); await close()
})

const signUp = async (name, email) => {
  const c = client(app)
  const r = await c.post('/api/register/password', { name, email, password: 'correct-horse-battery' })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

/** A coach with a client who has accepted, before any of the billing states are forced. */
const linked = async () => {
  const { c: coach, user: coachUser } = await signUp('Coach', 'coach@x.test')
  const invite = await coach.post('/api/coach/invites', { email: 'client@x.test' })
  expect(invite.status).toBe(200)

  const { c: cl, user: clientUser } = await signUp('Client', 'client@x.test')
  const accept = await cl.post(`/api/invites/${invite.body.invite.code}/accept`, {})
  expect(accept.status).toBe(200)

  return { coach, coachUser, cl, clientUser, linkId: accept.body.link.id }
}

/* The billing states, forced directly rather than by waiting a fortnight. */
const expireTrial = id => db()`update subscriptions set trial_ends_at = ${new Date(Date.now() - (GRACE_DAYS + 2) * DAY)} where user_id = ${id}`
const intoGrace = id => db()`update subscriptions set trial_ends_at = null, paid_through = ${new Date(Date.now() - DAY)} where user_id = ${id}`

describe('status', () => {
  it('reports a trial once coaching has started, and what it would cost to keep it', async () => {
    const { coachUser, coach } = await linked()
    const r = await coach.get('/api/billing/status')

    expect(r.body.enabled).toBe(true)
    expect(r.body.entitlement.state).toBe('trial')
    expect(r.body.entitlement.daysLeft).toBe(TRIAL_DAYS)
    expect(r.body.terms.map(t => t.months)).toEqual([1, 3, 12])
    expect(await subscriptionFor(coachUser.id)).not.toBeNull()
  })

  it('reports nothing for somebody who has never coached', async () => {
    const { c } = await signUp('Solo', 'solo@x.test')
    const r = await c.get('/api/billing/status')
    expect(r.body.entitlement.state).toBe('none')
    expect(r.body.payments).toEqual([])
  })

  it('needs a session', async () => {
    expect((await client(app).get('/api/billing/status')).status).toBe(401)
  })
})

describe('an instance with no gateway configured', () => {
  beforeEach(() => { delete process.env.ZARINPAL_MERCHANT_ID })

  it('says billing is off and offers nothing', async () => {
    const { c } = await signUp('Solo', 'solo@x.test')
    const r = await c.get('/api/billing/status')

    expect(r.body.enabled).toBe(false)
    expect(r.body.terms).toEqual([])
    expect(r.body.entitlement.state).toBe('unbilled')
  })

  it('leaves every coaching feature free — this is what self-hosting looks like', async () => {
    const { coach, clientUser, linkId } = await linked()
    // No subscription row was created, and nothing asked for one.
    expect(await subscriptionFor((await db()`select id from users where email = 'coach@x.test'`)[0].id)).toBeNull()

    const msg = await coach.post(`/api/threads/${linkId}`, { body: 'hello' })
    expect(msg.status).toBe(200)

    const propose = await coach.post(`/api/coach/clients/${clientUser.id}/propose`, {
      routineId: 'r1', payload: { name: 'Upper', days: [] }
    })
    expect(propose.status).toBe(200)
  })
})

describe('the gate', () => {
  it('lets a trialling coach do everything', async () => {
    const { coach, clientUser, linkId } = await linked()
    expect((await coach.post(`/api/threads/${linkId}`, { body: 'hi' })).status).toBe(200)
    expect((await coach.post(`/api/coach/clients/${clientUser.id}/propose`, {
      routineId: 'r1', payload: { name: 'Upper', days: [] }
    })).status).toBe(200)
  })

  it('stops a lapsed coach taking on anybody new', async () => {
    const { coach, coachUser } = await linked()
    await expireTrial(coachUser.id)

    const r = await coach.post('/api/coach/invites', { email: 'another@x.test' })
    expect(r.status).toBe(402)
    expect(r.body.code).toBe('payment_required')
  })

  it('stops a coach in grace proposing, but not talking', async () => {
    const { coach, coachUser, clientUser, linkId } = await linked()
    await intoGrace(coachUser.id)

    const propose = await coach.post(`/api/coach/clients/${clientUser.id}/propose`, {
      routineId: 'r1', payload: { name: 'Upper', days: [] }
    })
    expect(propose.status).toBe(402)
    expect((await coach.post(`/api/threads/${linkId}`, { body: 'your card expired' })).status).toBe(200)
  })

  it('stops a fully expired coach writing at all', async () => {
    const { coach, coachUser, linkId } = await linked()
    await expireTrial(coachUser.id)
    expect((await coach.post(`/api/threads/${linkId}`, { body: 'hi' })).status).toBe(402)
  })

  it('never stops a coach reading the roster they built', async () => {
    const { coach, coachUser, clientUser } = await linked()
    await expireTrial(coachUser.id)

    expect((await coach.get('/api/coach/clients')).status).toBe(200)
    expect((await coach.get(`/api/coach/clients/${clientUser.id}`)).status).toBe(200)
  })

  it('never stops the client — they are not the one who pays', async () => {
    const { cl, coachUser, linkId } = await linked()
    await expireTrial(coachUser.id)

    expect((await cl.post(`/api/threads/${linkId}`, { body: 'am I still coached?' })).status).toBe(200)
    expect((await cl.get(`/api/threads/${linkId}`)).status).toBe(200)
    expect((await cl.get('/api/coaches')).status).toBe(200)
  })

  it('lets a client accept a proposal their coach made before lapsing', async () => {
    const { coach, coachUser, cl, clientUser } = await linked()
    const p = await coach.post(`/api/coach/clients/${clientUser.id}/propose`, {
      routineId: 'r1', payload: { name: 'Upper', days: [] }
    })
    await expireTrial(coachUser.id)

    expect((await cl.post(`/api/proposals/${p.body.proposal.id}/accept`, {})).status).toBe(200)
  })

  it('says which state the refusal came from, so the prompt can be the right one', async () => {
    const { coach, coachUser } = await linked()
    await intoGrace(coachUser.id)
    const r = await coach.post('/api/coach/invites', { email: 'x@x.test' })
    expect(r.body.details.state).toBe('grace')
  })
})

describe('checkout', () => {
  it('records the attempt, asks the gateway, and hands back somewhere to go', async () => {
    const { coach, coachUser } = await linked()
    const r = await coach.post('/api/billing/checkout', { months: 3 })

    expect(r.status).toBe(200)
    expect(r.body.startUrl).toContain('StartPay')
    expect(gw.request).toHaveBeenCalledOnce()

    const [row] = await db()`select * from payments where user_id = ${coachUser.id}`
    expect(row.status).toBe('pending')
    expect(row.months).toBe(3)
    expect(Number(row.amount)).toBe(r.body.amount)
    expect(row.authority).not.toBeNull()
  })

  it('sends the gateway the amount it stored, in the currency it stored', async () => {
    const { coach } = await linked()
    const r = await coach.post('/api/billing/checkout', { months: 1 })
    expect(gw.request.mock.calls[0][0].amount).toBe(r.body.amount)
    expect(r.body.currency).toBe('IRR')
  })

  it('refuses a term that is not on offer', async () => {
    const { coach } = await linked()
    expect((await coach.post('/api/billing/checkout', { months: 7 })).status).toBe(400)
    expect((await coach.post('/api/billing/checkout', { months: 0 })).status).toBe(400)
    expect(gw.request).not.toHaveBeenCalled()
  })

  it('closes the row when the gateway cannot be reached, rather than leaving it to haunt reconciliation', async () => {
    const { coach, coachUser } = await linked()
    gw.request = vi.fn(async () => { throw new Error('gateway down') })

    const r = await coach.post('/api/billing/checkout', { months: 1 })
    expect(r.status).toBe(502)

    const [row] = await db()`select * from payments where user_id = ${coachUser.id}`
    expect(row.status).toBe('failed')
  })

  it('needs a session', async () => {
    expect((await client(app).post('/api/billing/checkout', { months: 1 })).status).toBe(401)
  })
})

describe('the callback', () => {
  /** Run a checkout and hand back the authority the gateway minted for it. */
  const started = async (coach, months = 1) => {
    const r = await coach.post('/api/billing/checkout', { months })
    const [row] = await db()`select * from payments where id = ${r.body.paymentId}`
    return row
  }

  it('credits a verified payment and sends them back into the app', async () => {
    const { coach, coachUser } = await linked()
    const p = await started(coach, 3)

    const r = await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=OK`)

    expect(r.status).toBe(302)
    expect(r.headers.location).toContain('billing=ok')

    const status = await coach.get('/api/billing/status')
    expect(status.body.entitlement.state).toBe('active')
    expect(status.body.entitlement.daysLeft).toBeGreaterThan(85)
    expect((await db()`select status from payments where id = ${p.id}`)[0].status).toBe('paid')
  })

  it('verifies against the stored amount, not anything from the request', async () => {
    const { coach } = await linked()
    const p = await started(coach, 12)
    await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=OK&amount=1`)
    expect(gw.verify.mock.calls[0][0].amount).toBe(Number(p.amount))
  })

  it('credits a second arrival of the same receipt exactly zero more times', async () => {
    const { coach } = await linked()
    const p = await started(coach, 1)

    const first = await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=OK`)
    const after = (await coach.get('/api/billing/status')).body.entitlement.until

    // The refresh: same authority, and Zarinpal answering 101 with the same receipt.
    gw.verify = vi.fn(async () => ({ ok: true, alreadyVerified: true, refId: 'R-same', code: 101, raw: {} }))
    const second = await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=OK`)

    expect(first.headers.location).toContain('billing=ok')
    expect(second.headers.location).toContain('billing=already')
    expect((await coach.get('/api/billing/status')).body.entitlement.until).toBe(after)
  })

  it('treats a cancelled payment as cancelled, and charges nothing', async () => {
    const { coach } = await linked()
    const p = await started(coach)

    const r = await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=NOK`)

    expect(r.headers.location).toContain('billing=cancelled')
    expect(gw.verify).not.toHaveBeenCalled()
    expect((await db()`select status from payments where id = ${p.id}`)[0].status).toBe('abandoned')
  })

  it('does not take Status=OK as proof — only the gateway saying so', async () => {
    const { coach } = await linked()
    const p = await started(coach)
    gw.verify = vi.fn(async () => ({ ok: false, code: -51, reason: 'the payment did not complete' }))

    const r = await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=OK`)

    expect(r.headers.location).toContain('billing=failed')
    expect((await coach.get('/api/billing/status')).body.entitlement.state).toBe('trial')
  })

  it('leaves the row pending when verification itself fails, so reconciliation can find it', async () => {
    const { coach } = await linked()
    const p = await started(coach)
    gw.verify = vi.fn(async () => { throw new Error('gateway timeout') })

    const r = await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=OK`)

    expect(r.headers.location).toContain('billing=pending')
    // Not failed. They may well have paid, and marking it failed loses that.
    expect((await db()`select status from payments where id = ${p.id}`)[0].status).toBe('pending')
  })

  it('shrugs at an authority it never issued', async () => {
    const { coach } = await linked()
    const r = await coach.get('/api/billing/callback?Authority=A-invented&Status=OK')

    expect(r.headers.location).toContain('billing=unknown')
    expect(gw.verify).not.toHaveBeenCalled()
  })

  it('redirects rather than erroring when the query string is empty', async () => {
    const r = await client(app).get('/api/billing/callback')
    expect(r.status).toBe(302)
    expect(r.headers.location).toContain('billing=unknown')
  })

  it('works without a session — the payment row says whose it is', async () => {
    const { coach } = await linked()
    const p = await started(coach)

    // A different browser entirely, carrying no cookie.
    const stranger = client(app)
    const r = await stranger.get(`/api/billing/callback?Authority=${p.authority}&Status=OK`)

    expect(r.headers.location).toContain('billing=ok')
    expect((await coach.get('/api/billing/status')).body.entitlement.state).toBe('active')
  })

  it('accepts the lower-case spelling too', async () => {
    const { coach } = await linked()
    const p = await started(coach)
    const r = await coach.get(`/api/billing/callback?authority=${p.authority}&status=ok`)
    expect(r.headers.location).toContain('billing=ok')
  })
})

describe('paying puts a lapsed coach straight back to work', () => {
  it('takes them from refused to proposing in one purchase', async () => {
    const { coach, coachUser, clientUser } = await linked()
    await expireTrial(coachUser.id)

    const propose = () => coach.post(`/api/coach/clients/${clientUser.id}/propose`, {
      routineId: 'r1', payload: { name: 'Upper', days: [] }
    })
    expect((await propose()).status).toBe(402)

    const r = await coach.post('/api/billing/checkout', { months: 1 })
    const [p] = await db()`select * from payments where id = ${r.body.paymentId}`
    await coach.get(`/api/billing/callback?Authority=${p.authority}&Status=OK`)

    expect((await propose()).status).toBe(200)
  })
})

describe('the trial endpoint', () => {
  it('starts one, and starting it again changes nothing', async () => {
    const { c, user } = await signUp('Coach', 'coach@x.test')

    const first = await c.post('/api/billing/trial', {})
    expect(first.body.entitlement.state).toBe('trial')

    const second = await c.post('/api/billing/trial', {})
    expect(second.body.entitlement.until).toBe(first.body.entitlement.until)
  })

  it('does not resurrect a trial that has been used up', async () => {
    const { c, user } = await signUp('Coach', 'coach@x.test')
    await ensureTrial(user.id)
    await expireTrial(user.id)

    const r = await c.post('/api/billing/trial', {})
    expect(r.body.entitlement.state).toBe('expired')
  })

  it('does not overwrite a paid subscription', async () => {
    const { c, user } = await signUp('Coach', 'coach@x.test')
    await setPaidThrough(user.id, new Date(Date.now() + 60 * DAY))

    const r = await c.post('/api/billing/trial', {})
    expect(r.body.entitlement.state).toBe('active')
  })
})

describe('the client cap', () => {
  /** Put this coach on a tier of `cap` clients, the way a purchase would. */
  const setCap = (id, cap, tier = 'solo') => db()`
    update subscriptions set tier = ${tier}, client_cap = ${cap} where user_id = ${id}`

  it('reports how much room is left, on the screen that is about it', async () => {
    const { coach, coachUser } = await linked()
    await setCap(coachUser.id, 5)

    const r = await coach.get('/api/coach/clients')
    expect(r.status).toBe(200)
    expect(r.body.capacity).toMatchObject({ cap: 5, used: 1, remaining: 4, full: false, tier: 'solo' })
  })

  it('tells a full coach their plan is too small, and which one is not', async () => {
    const { coach, coachUser } = await linked()
    await setCap(coachUser.id, 1)

    const r = await coach.post('/api/coach/invites', { email: 'another@x.test' })
    expect(r.status).toBe(402)
    expect(r.body.code).toBe('client_cap_reached')
    // A wall that names the way over it. `studio` is the next size up from `solo`.
    expect(r.body.details).toMatchObject({ cap: 1, used: 1, tier: 'solo', nextTier: 'studio' })
  })

  it('has nothing to offer a full coach on the largest tier', async () => {
    const { coach, coachUser } = await linked()
    await setCap(coachUser.id, 1, 'pro')
    const r = await coach.post('/api/coach/invites', { email: 'another@x.test' })
    expect(r.body.details.nextTier).toBeNull()
  })

  it('never hands a client a bill for their coach’s plan', async () => {
    // The invitation is issued while there is room, and the coach fills up before it is used.
    const { coach, coachUser } = await linked()
    const invite = await coach.post('/api/coach/invites', { email: 'second@x.test' })
    expect(invite.status).toBe(200)
    await setCap(coachUser.id, 1)

    const { c: second } = await signUp('Second', 'second@x.test')
    const r = await second.post(`/api/invites/${invite.body.invite.code}/accept`, {})

    // 409, not 402. A person being coached must never see a payment prompt that is not theirs.
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('coach_at_capacity')
  })

  it('leaves every existing client alone when the coach is over their cap', async () => {
    const { coach, coachUser, cl, linkId } = await linked()

    // A second client, while there is still room for one.
    const invite = await coach.post('/api/coach/invites', { email: 'second@x.test' })
    const { c: second } = await signUp('Second', 'second@x.test')
    expect((await second.post(`/api/invites/${invite.body.invite.code}/accept`, {})).status).toBe(200)

    // Then they downgrade to a tier smaller than the book they already have.
    await setCap(coachUser.id, 1)
    const seen = await coach.get('/api/coach/clients')
    expect(seen.body.capacity).toMatchObject({ cap: 1, used: 2, remaining: 0, full: true })

    // Both clients are still there, still readable, still being coached.
    expect(seen.body.clients).toHaveLength(2)
    expect((await cl.get('/api/coaches')).body.coaches).toHaveLength(1)
    expect((await second.get('/api/coaches')).body.coaches).toHaveLength(1)
    // And they can still talk to each other.
    expect((await coach.post(`/api/threads/${linkId}`, { body: 'still here' })).status).toBe(200)

    // Only growth is refused.
    expect((await coach.post('/api/coach/invites', { email: 'third@x.test' })).status).toBe(402)
  })

  it('does not cap a coach who is still on trial', async () => {
    const { coach } = await linked()
    // A trial writes a subscription row with no cap on it — capping a trial would advertise a
    // worse product than the one being sold.
    const r = await coach.post('/api/coach/invites', { email: 'third@x.test' })
    expect(r.status).toBe(200)
  })

  it('does not cap anybody on an instance with no gateway', async () => {
    const { coach, coachUser } = await linked()
    await setCap(coachUser.id, 1)
    delete process.env.ZARINPAL_MERCHANT_ID

    const r = await coach.post('/api/coach/invites', { email: 'another@x.test' })
    expect(r.status).toBe(200)
    expect((await coach.get('/api/coach/clients')).body.capacity.cap).toBeNull()
  })
})

describe('the price index, end to end', () => {
  const RATE_KEYS = ['TOMAN_PER_USD', 'TOMAN_PER_USD_AT', 'PRICE_BASELINE_TOMAN_PER_USD']
  afterEach(() => { for (const k of RATE_KEYS) delete process.env[k] })

  const rate = (toman, baseline, days = 0) => {
    process.env.TOMAN_PER_USD = String(toman)
    process.env.PRICE_BASELINE_TOMAN_PER_USD = String(baseline)
    process.env.TOMAN_PER_USD_AT = new Date(Date.now() - days * DAY).toISOString()
  }

  it('says nothing is indexed on an instance that never set a rate', async () => {
    const { coach } = await linked()
    const r = await coach.get('/api/billing/status')
    expect(r.body.priceIndex).toMatchObject({ usable: false, stale: false, tomanPerUsd: null })
    expect(r.body.terms.map(t => t.months)).toEqual([1, 3, 12])
  })

  it('charges the indexed price, not the written one', async () => {
    const { coach } = await linked()
    rate(220_000, 200_000)
    const r = await coach.post('/api/billing/checkout', { months: 1, tier: 'solo' })
    expect(r.status).toBe(200)
    expect(r.body.amount).toBe(1_640_000)          // 164,000 Toman in Rials
    expect(gw.request).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_640_000 }))
  })

  it('writes the rate onto the attempt, where it can never be recovered later', async () => {
    const { coach, coachUser } = await linked()
    rate(203_200, 200_000)
    await coach.post('/api/billing/checkout', { months: 1, tier: 'solo' })
    const [p] = await db()`select * from payments where user_id = ${coachUser.id}`
    expect(Number(p.toman_per_usd)).toBe(203_200)
  })

  it('leaves the rate null when there is none to record', async () => {
    const { coach, coachUser } = await linked()
    await coach.post('/api/billing/checkout', { months: 1, tier: 'solo' })
    const [p] = await db()`select * from payments where user_id = ${coachUser.id}`
    // Never invented. A rate that was not known then is not knowable now.
    expect(p.toman_per_usd).toBeNull()
  })

  it('stops selling a year on a rate nobody has refreshed', async () => {
    const { coach } = await linked()
    rate(220_000, 200_000, 30)

    const r = await coach.get('/api/billing/status')
    expect(r.body.priceIndex.stale).toBe(true)
    // The card is gone from the screen…
    expect(r.body.terms.map(t => t.months)).toEqual([1])
    // …and posting it anyway does not work either.
    expect((await coach.post('/api/billing/checkout', { months: 12, tier: 'solo' })).status).toBe(400)
    // A month is still fine. The exposure is capped, not the business.
    expect((await coach.post('/api/billing/checkout', { months: 1, tier: 'solo' })).status).toBe(200)
  })

  it('does not hand the payer this instance’s margins', async () => {
    const { coach } = await linked()
    rate(220_000, 200_000)
    const r = await coach.get('/api/billing/status')
    // The rate is public; what the price list was written at is nobody's business but ours.
    expect(r.body.priceIndex.tomanPerUsd).toBe(220_000)
    expect(r.body.priceIndex).not.toHaveProperty('baseline')
    expect(r.body.priceIndex).not.toHaveProperty('multiplier')
  })
})

describe('the billing screen’s data', () => {
  const setCap = (id, cap, tier = 'solo') => db()`
    update subscriptions set tier = ${tier}, client_cap = ${cap} where user_id = ${id}`

  it('carries the whole grid, each tier with its terms and its ceiling', async () => {
    const { coach } = await linked()
    const r = await coach.get('/api/billing/status')

    expect(r.body.tiers.map(x => x.tier)).toEqual(['solo', 'studio', 'pro'])
    expect(r.body.tiers.map(x => x.clientCap)).toEqual([5, 25, 100])
    for (const x of r.body.tiers) expect(x.terms.map(term => term.months)).toEqual([1, 3, 12])
  })

  it('costs more for a bigger plan, and less per month for a longer one', async () => {
    const { coach } = await linked()
    const [solo, studio, pro] = (await coach.get('/api/billing/status')).body.tiers
    expect(solo.terms[0].toman).toBeLessThan(studio.terms[0].toman)
    expect(studio.terms[0].toman).toBeLessThan(pro.terms[0].toman)
    for (const x of [solo, studio, pro]) {
      expect(x.terms[2].perMonthToman).toBeLessThan(x.terms[0].perMonthToman)
    }
  })

  it('says how full the plan is, so the screen can pick one that fits', async () => {
    const { coach, coachUser } = await linked()
    await setCap(coachUser.id, 25, 'studio')
    const r = await coach.get('/api/billing/status')
    expect(r.body.capacity).toMatchObject({ cap: 25, used: 1, remaining: 24, tier: 'studio' })
  })

  it('charges the tier that was chosen, not the cheapest one', async () => {
    const { coach, coachUser } = await linked()
    const r = await coach.post('/api/billing/checkout', { months: 1, tier: 'pro' })

    expect(r.status).toBe(200)
    expect(r.body.tier).toBe('pro')
    expect(r.body.amount).toBe(7_490_000)          // 749,000 Toman in Rials
    const [p] = await db()`select * from payments where user_id = ${coachUser.id}`
    expect(p.tier).toBe('pro')
  })

  it('tells the payer at the gateway how many clients they are buying', async () => {
    const { coach } = await linked()
    await coach.post('/api/billing/checkout', { months: 3, tier: 'studio' })
    // The last thing they read before paying, on a bank page where "studio" means nothing.
    expect(gw.request).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining('25 clients') })
    )
  })

  it('refuses a tier that is not for sale', async () => {
    const { coach } = await linked()
    expect((await coach.post('/api/billing/checkout', { months: 1, tier: 'legacy' })).status).toBe(400)
    expect((await coach.post('/api/billing/checkout', { months: 1, tier: 'enterprise' })).status).toBe(400)
  })

  it('still sells the entry tier to a client that never heard of tiers', async () => {
    const { coach } = await linked()
    const r = await coach.post('/api/billing/checkout', { months: 1 })
    expect(r.status).toBe(200)
    expect(r.body.tier).toBe('solo')
  })
})
