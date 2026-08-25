/* The client's half of billing is mostly a decision table: which sentence, and how loudly.
 *
 * Worth testing because it is the same table read from three screens, and the states that
 * matter most are the ones nobody clicks through by hand — a subscription three days from
 * lapsing, a payment that came back unconfirmed.
 */
import { describe, it, expect } from 'vitest'
import { describeEntitlement, readOutcome, isPaymentRequired, termLabel, CHECKOUT_OUTCOMES, isCapReached} from './billing.js'

const DAY = 86400000
const inDays = n => new Date(Date.now() + n * DAY).toISOString()

describe('describing an entitlement', () => {
  it('says nothing at all on an instance that does not bill', () => {
    // The whole subscription UI hides on this. A self-hosted GymBuddy should not know the
    // concept exists, let alone advertise it.
    expect(describeEntitlement({ state: 'unbilled', can: {} })).toBeNull()
  })

  it('says nothing when there is no entitlement to describe', () => {
    expect(describeEntitlement(null)).toBeNull()
    expect(describeEntitlement(undefined)).toBeNull()
  })

  it('is quiet about a healthy subscription', () => {
    const d = describeEntitlement({ state: 'active', daysLeft: 200, until: inDays(200) })
    expect(d.tone).toBe('ok')
    expect(d.title).toMatch(/active/i)
  })

  it('raises its voice as a subscription gets close to lapsing', () => {
    expect(describeEntitlement({ state: 'active', daysLeft: 30, until: inDays(30) }).tone).toBe('ok')
    expect(describeEntitlement({ state: 'active', daysLeft: 5, until: inDays(5) }).tone).toBe('warn')
  })

  it('does the same for a trial, on a shorter fuse', () => {
    expect(describeEntitlement({ state: 'trial', daysLeft: 10, until: inDays(10) }).tone).toBe('ok')
    expect(describeEntitlement({ state: 'trial', daysLeft: 2, until: inDays(2) }).tone).toBe('warn')
  })

  it('says "tomorrow" rather than "1 days"', () => {
    const d = describeEntitlement({ state: 'trial', daysLeft: 1, until: inDays(1) })
    expect(d.title).toMatch(/tomorrow/i)
    expect(d.title).not.toMatch(/1 days/)
  })

  it('warns during grace and says exactly what still works', () => {
    const d = describeEntitlement({ state: 'grace', daysLeft: 4, until: inDays(4) })
    expect(d.tone).toBe('warn')
    expect(d.detail).toMatch(/message/i)
    expect(d.detail).toMatch(/4/)
  })

  it('promises an expired coach that their clients lose nothing', () => {
    const d = describeEntitlement({ state: 'expired', daysLeft: null, until: null })
    expect(d.tone).toBe('stop')
    // The single most important sentence on the screen: nobody's training is hostage.
    expect(d.detail).toMatch(/lose nothing/i)
  })

  it('tells somebody who never subscribed that their own training is not at stake', () => {
    const d = describeEntitlement({ state: 'none', daysLeft: null, until: null })
    expect(d.tone).toBe('stop')
    expect(d.detail).toMatch(/your own training does not/i)
  })

  it('has a title and a tone for every state the server can send', () => {
    for (const state of ['active', 'trial', 'grace', 'expired', 'none']) {
      const d = describeEntitlement({ state, daysLeft: 5, until: inDays(5) })
      expect(d.title).toBeTruthy()
      expect(['ok', 'warn', 'stop']).toContain(d.tone)
    }
  })
})

describe('reading a checkout outcome', () => {
  it('has wording for every outcome the callback can redirect with', () => {
    // These are the exact strings routes/billing.js puts on the URL. A mismatch here is a
    // blank screen after a real payment.
    for (const key of ['ok', 'already', 'cancelled', 'failed', 'pending', 'unknown']) {
      expect(CHECKOUT_OUTCOMES[key], key).toBeTypeOf('function')
      expect(readOutcome(key).message).toBeTruthy()
    }
  })

  it('ignores a query parameter it does not recognise', () => {
    expect(readOutcome('banana')).toBeNull()
    expect(readOutcome(null)).toBeNull()
  })

  it('promises no charge on the two outcomes where none was made', () => {
    expect(readOutcome('cancelled').message).toMatch(/not been charged/i)
    expect(readOutcome('failed').message).toMatch(/not been charged/i)
  })

  it('never tells somebody an unconfirmed payment failed', () => {
    const p = readOutcome('pending')
    expect(p.tone).toBe('warn')
    expect(p.message).not.toMatch(/failed|did not go through/i)
    // And it heads off the expensive mistake.
    expect(p.message).toMatch(/do not pay again/i)
  })
})

describe('spotting a refusal for want of payment', () => {
  it('recognises the status and the code independently', () => {
    expect(isPaymentRequired({ status: 402 })).toBe(true)
    expect(isPaymentRequired({ code: 'payment_required' })).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isPaymentRequired({ status: 403 })).toBe(false)
    expect(isPaymentRequired({ status: 500 })).toBe(false)
    expect(isPaymentRequired(null)).toBe(false)
    expect(isPaymentRequired(undefined)).toBe(false)
  })
})

describe('term labels', () => {
  it('says a year rather than twelve months', () => {
    expect(termLabel(12)).toMatch(/year/i)
    expect(termLabel(1)).toMatch(/1 month/i)
    expect(termLabel(3)).toMatch(/3 months/i)
  })
})

describe('spotting a full plan', () => {
  it('recognises the cap refusal', () => {
    expect(isCapReached({ status: 402, code: 'client_cap_reached' })).toBe(true)
  })

  it('does not confuse it with a lapsed subscription', () => {
    // Both are 402 and both end at the billing screen, but they are different sentences.
    expect(isCapReached({ status: 402, code: 'payment_required' })).toBe(false)
    expect(isCapReached({ status: 402 })).toBe(false)
    expect(isCapReached(null)).toBe(false)
  })

  it('is still a payment refusal, so the existing routing keeps working', () => {
    expect(isPaymentRequired({ status: 402, code: 'client_cap_reached' })).toBe(true)
  })
})
