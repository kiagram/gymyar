/* Billing storage, against a real Postgres — because the guarantees being tested are the
 * database's, not the code's. A fake would happily let both halves of the double-credit test
 * pass while production lost money.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import { createUser } from './users.js'
import { db } from './index.js'
import {
  subscriptionFor, subscriptionsFor, ensureTrial, startPayment, attachAuthority,
  paymentByAuthority, paymentsFor, credit, settleUnpaid, stalePayments, setPaidThrough
} from './billing.js'
import { entitlement, TRIAL_DAYS, capFor } from '@gymyar/domain/entitlement.js'

beforeAll(async () => { await setupDb() })
beforeEach(async () => { await truncateUsers() })
afterAll(async () => { await teardownDb() })

const DAY = 86400000
const coach = (email = 'coach@x.test') => createUser({ name: 'Coach', email, isCoach: true })

const attempt = async (userId, months = 1, amount = 1_490_000, tier = null) => {
  const p = await startPayment({ userId, gateway: 'zarinpal', amount, currency: 'IRR', months, tier })
  return attachAuthority(p.id, 'A-' + p.id.slice(0, 8))
}

describe('trials', () => {
  it('does not exist until somebody starts one', async () => {
    const u = await coach()
    expect(await subscriptionFor(u.id)).toBeNull()
    expect(entitlement(null).state).toBe('none')
  })

  it('starts a trial of the length the domain says', async () => {
    const u = await coach()
    const sub = await ensureTrial(u.id)
    const ent = entitlement(sub)
    expect(ent.state).toBe('trial')
    expect(ent.daysLeft).toBe(TRIAL_DAYS)
  })

  it('never hands out a second trial', async () => {
    const u = await coach()
    const first = await ensureTrial(u.id)
    // Two weeks later they come back and the code runs again.
    const second = await ensureTrial(u.id, db(), Date.now() + 14 * DAY)
    expect(second.trial_ends_at.getTime()).toBe(first.trial_ends_at.getTime())
  })

  it('does not disturb a paid subscription', async () => {
    const u = await coach()
    const paid = new Date(Date.now() + 90 * DAY)
    await setPaidThrough(u.id, paid)
    const sub = await ensureTrial(u.id)
    expect(sub.paid_through.getTime()).toBe(paid.getTime())
    expect(sub.trial_ends_at).toBeNull()
  })
})

describe('crediting a payment', () => {
  it('marks it paid, records the receipt and moves the date out', async () => {
    const u = await coach()
    const p = await attempt(u.id, 3)

    const { credited, payment, subscription } = await credit({ paymentId: p.id, refId: 'R1' })

    expect(credited).toBe(true)
    expect(payment.status).toBe('paid')
    expect(payment.ref_id).toBe('R1')
    expect(payment.settled_at).not.toBeNull()
    expect(entitlement(subscription).state).toBe('active')
    // Three months, near enough — the exact arithmetic is the domain's and tested there.
    expect(subscription.paid_through.getTime()).toBeGreaterThan(Date.now() + 85 * DAY)
  })

  it('credits the same receipt exactly once, however many times it arrives', async () => {
    const u = await coach()
    const p = await attempt(u.id, 1)

    const first = await credit({ paymentId: p.id, refId: 'R1' })
    const second = await credit({ paymentId: p.id, refId: 'R1' })

    expect(first.credited).toBe(true)
    expect(second.credited).toBe(false)

    const sub = await subscriptionFor(u.id)
    expect(sub.paid_through.getTime()).toBe(first.subscription.paid_through.getTime())
  })

  it('refuses a receipt already spent on a different attempt', async () => {
    // The 101 case: they paid once, we somehow have two rows, and only one may be credited.
    const u = await coach()
    const a = await attempt(u.id, 1)
    const b = await attempt(u.id, 12)

    await credit({ paymentId: a.id, refId: 'SAME' })
    const second = await credit({ paymentId: b.id, refId: 'SAME' })

    expect(second.credited).toBe(false)
    // A year did not get added on the strength of a duplicate.
    const sub = await subscriptionFor(u.id)
    expect(sub.paid_through.getTime()).toBeLessThan(Date.now() + 40 * DAY)
  })

  it('survives two callbacks racing, crediting one of them', async () => {
    const u = await coach()
    const p = await attempt(u.id, 1)

    const [x, y] = await Promise.all([
      credit({ paymentId: p.id, refId: 'R-race' }),
      credit({ paymentId: p.id, refId: 'R-race' })
    ])

    expect([x.credited, y.credited].filter(Boolean)).toHaveLength(1)
    const paid = await db()`select count(*)::int as n from payments where status = 'paid'`
    expect(paid[0].n).toBe(1)
  })

  it('stacks a renewal onto the time still remaining', async () => {
    const u = await coach()
    const remaining = new Date(Date.now() + 20 * DAY)
    await setPaidThrough(u.id, remaining)

    const p = await attempt(u.id, 1)
    const { subscription } = await credit({ paymentId: p.id, refId: 'R2' })

    // A month added to the 20 days left, not a month from today.
    expect(subscription.paid_through.getTime()).toBeGreaterThan(Date.now() + 45 * DAY)
  })

  it('starts from today when the old date has already gone', async () => {
    const u = await coach()
    await setPaidThrough(u.id, new Date(Date.now() - 60 * DAY))

    const p = await attempt(u.id, 1)
    const { subscription } = await credit({ paymentId: p.id, refId: 'R3' })

    expect(entitlement(subscription).state).toBe('active')
    expect(subscription.paid_through.getTime()).toBeLessThan(Date.now() + 32 * DAY)
  })

  it('keeps the gateway detail on the row without letting it near the caller', async () => {
    const u = await coach()
    const p = await attempt(u.id)
    await credit({ paymentId: p.id, refId: 'R4', detail: { card_pan: '6037****1234' } })

    const [row] = await db()`select detail from payments where id = ${p.id}`
    expect(row.detail).toEqual({ card_pan: '6037****1234' })
  })
})

describe('attempts that did not become money', () => {
  it('records an abandoned attempt', async () => {
    const u = await coach()
    const p = await attempt(u.id)
    const out = await settleUnpaid(p.id, 'abandoned', { status: 'NOK' })

    expect(out.status).toBe('abandoned')
    expect(await subscriptionFor(u.id)).toBeNull()
  })

  it('will not quietly un-pay a paid attempt', async () => {
    const u = await coach()
    const p = await attempt(u.id)
    await credit({ paymentId: p.id, refId: 'R5' })

    expect(await settleUnpaid(p.id, 'failed', {})).toBeNull()
    expect((await paymentByAuthority('zarinpal', p.authority)).status).toBe('paid')
  })

  it('refuses a status that is not a way of not paying', async () => {
    const u = await coach()
    const p = await attempt(u.id)
    await expect(settleUnpaid(p.id, 'paid', {})).rejects.toThrow(/not an unpaid status/)
  })
})

describe('reconciliation', () => {
  it('finds attempts left pending past the window, and nothing else', async () => {
    const u = await coach()
    const old = await attempt(u.id)
    const fresh = await attempt(u.id)
    const settled = await attempt(u.id)

    await db()`update payments set created_at = now() - interval '2 hours' where id = ${old.id}`
    await db()`update payments set created_at = now() - interval '2 hours' where id = ${settled.id}`
    await credit({ paymentId: settled.id, refId: 'R6' })

    const stale = await stalePayments({ minutes: 15 })
    expect(stale.map(p => p.id)).toEqual([old.id])
    expect(stale.map(p => p.id)).not.toContain(fresh.id)
  })
})

describe('lookups', () => {
  it('finds an attempt by the gateway handle the callback carries', async () => {
    const u = await coach()
    const p = await attempt(u.id)
    expect((await paymentByAuthority('zarinpal', p.authority)).id).toBe(p.id)
    expect(await paymentByAuthority('zarinpal', 'nope')).toBeNull()
  })

  it('will not confuse two gateways using the same authority string', async () => {
    const u = await coach()
    const p = await attempt(u.id)
    await db()`update payments set gateway = 'other' where id = ${p.id}`
    expect(await paymentByAuthority('zarinpal', p.authority)).toBeNull()
  })

  it('lists a user\'s payments, newest first', async () => {
    const u = await coach()
    const a = await attempt(u.id)
    const b = await attempt(u.id)
    await db()`update payments set created_at = now() - interval '1 day' where id = ${a.id}`

    expect((await paymentsFor(u.id)).map(p => p.id)).toEqual([b.id, a.id])
  })

  it('reads many subscriptions in one query, for the roster', async () => {
    const a = await coach('a@x.test')
    const b = await coach('b@x.test')
    const c = await coach('c@x.test')
    await ensureTrial(a.id)
    await setPaidThrough(b.id, new Date(Date.now() + 30 * DAY))

    const map = await subscriptionsFor([a.id, b.id, c.id])
    expect(entitlement(map.get(a.id)).state).toBe('trial')
    expect(entitlement(map.get(b.id)).state).toBe('active')
    expect(entitlement(map.get(c.id)).state).toBe('none')
  })

  it('asks nothing of the database for an empty list', async () => {
    expect(await subscriptionsFor([])).toEqual(new Map())
  })
})

describe('the schema itself', () => {
  it('takes a subscription away with the account', async () => {
    const u = await coach()
    await ensureTrial(u.id)
    await db()`delete from users where id = ${u.id}`
    expect(await subscriptionFor(u.id)).toBeNull()
  })

  it('refuses an attempt for nothing, or for no months', async () => {
    const u = await coach()
    await expect(startPayment({ userId: u.id, gateway: 'zarinpal', amount: 0, currency: 'IRR', months: 1 }))
      .rejects.toThrow()
    await expect(startPayment({ userId: u.id, gateway: 'zarinpal', amount: 100, currency: 'IRR', months: 0 }))
      .rejects.toThrow()
  })

  it('refuses a currency it does not know how to send', async () => {
    const u = await coach()
    await expect(startPayment({ userId: u.id, gateway: 'zarinpal', amount: 100, currency: 'USD', months: 1 }))
      .rejects.toThrow()
  })

  it('refuses two attempts claiming one authority', async () => {
    const u = await coach()
    const a = await attempt(u.id)
    const b = await startPayment({ userId: u.id, gateway: 'zarinpal', amount: 1, currency: 'IRR', months: 1 })
    await expect(attachAuthority(b.id, a.authority)).rejects.toThrow()
  })

  it('keeps subscriptions out of sync — they are an account fact, not training data', async () => {
    const u = await coach()
    await ensureTrial(u.id)
    const log = await db()`select * from change_log where user_id = ${u.id}`
    expect(log).toHaveLength(0)
  })
})

describe('tiers', () => {
  it('starts a trial uncapped — a trial smaller than the product is not a trial', async () => {
    const u = await coach()
    const sub = await ensureTrial(u.id)
    expect(sub.tier).toBe('legacy')
    expect(sub.client_cap).toBeNull()
  })

  it('records what was actually sold on the attempt', async () => {
    const u = await coach()
    const p = await attempt(u.id, 3, 9_390_000, 'studio')
    expect(p.tier).toBe('studio')
  })

  it('applies the purchased tier and its cap when the payment lands', async () => {
    const u = await coach()
    const p = await attempt(u.id, 1, 3_490_000, 'studio')

    const { subscription } = await credit({ paymentId: p.id, refId: 'R-studio' })

    expect(subscription.tier).toBe('studio')
    expect(subscription.client_cap).toBe(capFor('studio'))
    expect(entitlement(subscription).state).toBe('active')
  })

  it('copies the cap onto the row rather than leaving it to be re-derived later', async () => {
    // The promise lives on the subscription, so reshaping what `pro` means later cannot take
    // capacity away from somebody who already bought it.
    const u = await coach()
    const p = await attempt(u.id, 1, 7_490_000, 'pro')
    await credit({ paymentId: p.id, refId: 'R-pro' })

    const [row] = await db()`select tier, client_cap from subscriptions where user_id = ${u.id}`
    expect(row.client_cap).toBe(100)
  })

  it('moves a coach up a tier on the next purchase, stacking the time', async () => {
    const u = await coach()
    const first = await attempt(u.id, 1, 1_490_000, 'solo')
    await credit({ paymentId: first.id, refId: 'R-1' })
    const before = (await subscriptionFor(u.id)).paid_through.getTime()

    const second = await attempt(u.id, 1, 3_490_000, 'studio')
    const { subscription } = await credit({ paymentId: second.id, refId: 'R-2' })

    expect(subscription.tier).toBe('studio')
    expect(subscription.client_cap).toBe(25)
    // Paying early is not punished: the second month stacks onto what was left of the first.
    expect(subscription.paid_through.getTime()).toBeGreaterThan(before)
  })

  it('lets a coach choose a smaller tier, and says so on the row', async () => {
    const u = await coach()
    const big = await attempt(u.id, 1, 7_490_000, 'pro')
    await credit({ paymentId: big.id, refId: 'R-big' })

    const small = await attempt(u.id, 1, 1_490_000, 'solo')
    const { subscription } = await credit({ paymentId: small.id, refId: 'R-small' })

    // A downgrade they chose. It only ever costs room to grow — no client is severed by it.
    expect(subscription.tier).toBe('solo')
    expect(subscription.client_cap).toBe(5)
  })

  it('leaves the tier alone for a payment that names none', async () => {
    // A row written before tiers existed. The months still land; nothing gets reclassified.
    const u = await coach()
    const up = await attempt(u.id, 1, 3_490_000, 'studio')
    await credit({ paymentId: up.id, refId: 'R-up' })

    const untyped = await attempt(u.id, 1, 1_490_000, null)
    const { subscription } = await credit({ paymentId: untyped.id, refId: 'R-untyped' })

    expect(subscription.tier).toBe('studio')
    expect(subscription.client_cap).toBe(25)
  })

  it('does not re-tier on a duplicate receipt', async () => {
    const u = await coach()
    const p = await attempt(u.id, 1, 3_490_000, 'studio')
    await credit({ paymentId: p.id, refId: 'R-dup' })
    const second = await credit({ paymentId: p.id, refId: 'R-dup' })

    expect(second.credited).toBe(false)
    const sub = await subscriptionFor(u.id)
    expect(sub.tier).toBe('studio')
  })

  it('refuses a tier nobody sells on an attempt', async () => {
    const u = await coach()
    await expect(attempt(u.id, 1, 1_000, 'legacy')).rejects.toThrow()
    await expect(attempt(u.id, 1, 1_000, 'enterprise')).rejects.toThrow()
  })

  it('refuses a subscription capped at nothing', async () => {
    const u = await coach()
    await ensureTrial(u.id)
    await expect(db()`update subscriptions set client_cap = 0 where user_id = ${u.id}`)
      .rejects.toThrow()
  })

  it('refuses a rate that is not a rate', async () => {
    const u = await coach()
    await expect(startPayment({
      userId: u.id, gateway: 'zarinpal', amount: 100, currency: 'IRR', months: 1,
      tier: 'solo', tomanPerUsd: 0
    })).rejects.toThrow()
  })

  it('stores the rate the money changed hands at', async () => {
    const u = await coach()
    const p = await startPayment({
      userId: u.id, gateway: 'zarinpal', amount: 1_490_000, currency: 'IRR', months: 1,
      tier: 'solo', tomanPerUsd: 203_200
    })
    expect(Number(p.toman_per_usd)).toBe(203_200)
  })
})
