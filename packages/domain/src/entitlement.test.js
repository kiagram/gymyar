import { describe, it, expect } from 'vitest'
import {
  entitlement, allows, extend, addMonths, trialEnd, TRIAL_DAYS, GRACE_DAYS,
  TIERS, PURCHASABLE_TIERS, DEFAULT_TIER, isTier, isPurchasableTier, tierFor, capFor,
  capacity, nextTierAfter
} from './entitlement.js'

const DAY = 86400000
const NOW = Date.parse('2026-03-15T12:00:00Z')
const at = days => new Date(NOW + days * DAY).toISOString()

describe('entitlement states', () => {
  it('is none for a user who has never coached', () => {
    const e = entitlement(null, NOW)
    expect(e.state).toBe('none')
    expect(e.until).toBeNull()
    expect(e.daysLeft).toBeNull()
    expect(e.everPaid).toBe(false)
  })

  it('is trial while the trial runs', () => {
    const e = entitlement({ trial_ends_at: at(5) }, NOW)
    expect(e.state).toBe('trial')
    expect(e.daysLeft).toBe(5)
    expect(e.everPaid).toBe(false)
  })

  it('is active while paid, and prefers paid over a still-running trial', () => {
    const e = entitlement({ trial_ends_at: at(5), paid_through: at(40) }, NOW)
    expect(e.state).toBe('active')
    expect(e.daysLeft).toBe(40)
    expect(e.everPaid).toBe(true)
  })

  it('falls back to the trial when a payment has already run out', () => {
    // Paid once, that ran out, but the trial somehow outlasts it — the longer one wins.
    expect(entitlement({ trial_ends_at: at(3), paid_through: at(-1) }, NOW).state).toBe('trial')
  })

  it('enters grace when the paid date passes, and stays there for GRACE_DAYS', () => {
    const sub = { paid_through: at(-1) }
    expect(entitlement(sub, NOW).state).toBe('grace')
    expect(entitlement(sub, NOW + (GRACE_DAYS - 2) * DAY).state).toBe('grace')
    expect(entitlement(sub, NOW + (GRACE_DAYS + 1) * DAY).state).toBe('expired')
  })

  it('counts grace from whichever ended later', () => {
    // Trial ran out long ago; the payment is what grace should be measured from.
    const sub = { trial_ends_at: at(-60), paid_through: at(-1) }
    expect(entitlement(sub, NOW).state).toBe('grace')
  })

  it('rounds days left up, so hours remaining is never zero days', () => {
    expect(entitlement({ paid_through: new Date(NOW + 6 * 3600_000) }, NOW).daysLeft).toBe(1)
  })

  it('accepts Date objects as readily as strings', () => {
    expect(entitlement({ paid_through: new Date(NOW + 10 * DAY) }, NOW).state).toBe('active')
  })
})

describe('what each state allows', () => {
  const states = {
    trial: { trial_ends_at: at(5) },
    active: { paid_through: at(30) },
    grace: { paid_through: at(-1) },
    expired: { paid_through: at(-90) },
    none: null
  }

  it('lets a paying or trialling coach do everything', () => {
    for (const key of ['trial', 'active']) {
      const { can } = entitlement(states[key], NOW)
      expect(can).toEqual({ readRoster: true, message: true, propose: true, takeClients: true })
    }
  })

  it('stops growth and authorship in grace but keeps the conversation open', () => {
    const { can } = entitlement(states.grace, NOW)
    expect(can.propose).toBe(false)
    expect(can.takeClients).toBe(false)
    expect(can.message).toBe(true)
    expect(can.readRoster).toBe(true)
  })

  it('never takes reading away, in any state', () => {
    for (const sub of Object.values(states)) {
      expect(entitlement(sub, NOW).can.readRoster).toBe(true)
    }
  })

  it('allows() agrees with the capability table', () => {
    expect(allows(states.active, 'propose', NOW)).toBe(true)
    expect(allows(states.grace, 'propose', NOW)).toBe(false)
    expect(allows(states.expired, 'message', NOW)).toBe(false)
  })

  it('refuses a capability name it does not know, rather than reading it as false', () => {
    expect(() => allows(states.active, 'refund', NOW)).toThrow(/unknown capability/)
  })
})

describe('extending a paid-through date', () => {
  it('stacks onto time still remaining', () => {
    const remaining = at(20)
    expect(extend(remaining, 1, NOW).toISOString())
      .toBe(addMonths(Date.parse(remaining), 1).toISOString())
  })

  it('starts from now when the old date is in the past', () => {
    expect(extend(at(-30), 1, NOW).toISOString()).toBe(addMonths(NOW, 1).toISOString())
  })

  it('starts from now for a first payment', () => {
    expect(extend(null, 3, NOW).toISOString()).toBe(addMonths(NOW, 3).toISOString())
  })

  it('takes a lapsed coach back to active immediately', () => {
    const paid_through = extend(at(-30), 1, NOW)
    expect(entitlement({ paid_through }, NOW).state).toBe('active')
  })
})

describe('addMonths', () => {
  it('clamps rather than overflowing a short month', () => {
    // Jan 31 + 1 month is the end of February, not the 3rd of March.
    expect(addMonths(Date.parse('2026-01-31T12:00:00Z'), 1).getMonth()).toBe(1)
    expect(addMonths(Date.parse('2026-01-31T12:00:00Z'), 1).getDate()).toBe(28)
  })

  it('handles a leap February', () => {
    expect(addMonths(Date.parse('2028-01-31T12:00:00Z'), 1).getDate()).toBe(29)
  })

  it('crosses a year boundary', () => {
    expect(addMonths(Date.parse('2026-11-15T12:00:00Z'), 3).getFullYear()).toBe(2027)
  })
})

describe('trialEnd', () => {
  it('is TRIAL_DAYS out, and reads as a running trial', () => {
    const sub = { trial_ends_at: trialEnd(NOW) }
    expect(entitlement(sub, NOW).state).toBe('trial')
    expect(entitlement(sub, NOW).daysLeft).toBe(TRIAL_DAYS)
    expect(entitlement(sub, NOW + (TRIAL_DAYS + 1) * DAY).state).toBe('grace')
  })
})

describe('tiers', () => {
  it('names every tier exactly once', () => {
    const ids = TIERS.map(t => t.id)
    expect(ids).toEqual(['legacy', 'solo', 'studio', 'pro'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('sells three of the four', () => {
    expect(PURCHASABLE_TIERS.map(t => t.id)).toEqual(['solo', 'studio', 'pro'])
    expect(isPurchasableTier('legacy')).toBe(false)
    expect(isTier('legacy')).toBe(true)
  })

  it('gets bigger as it gets further up the list', () => {
    const caps = PURCHASABLE_TIERS.map(t => t.clientCap)
    expect(caps).toEqual([...caps].sort((a, b) => a - b))
    expect(caps.every(c => c > 0)).toBe(true)
  })

  it('treats legacy as unlimited, not as zero', () => {
    // Everybody who bought before tiers existed bought no cap, and keeps it.
    expect(capFor('legacy')).toBeNull()
    expect(tierFor('legacy').clientCap).toBeNull()
  })

  it('defaults to the tier that promises nothing was taken away', () => {
    expect(DEFAULT_TIER).toBe('legacy')
    expect(capFor(DEFAULT_TIER)).toBeNull()
  })

  it('reads an unknown tier as unlimited rather than as capped', () => {
    // A name from a newer build, or a typo. Guessing generously costs a client we should have
    // been paid for; guessing meanly locks a paying coach out of their own business.
    expect(capFor('enterprise')).toBeNull()
    expect(capFor(null)).toBeNull()
    expect(capFor(undefined)).toBeNull()
    expect(tierFor('enterprise')).toBeNull()
  })

  it('gives every purchasable tier a real cap', () => {
    for (const t of PURCHASABLE_TIERS) {
      expect(typeof t.clientCap).toBe('number')
      expect(capFor(t.id)).toBe(t.clientCap)
    }
  })
})

describe('client capacity', () => {
  const sub = (client_cap, tier = 'solo') => ({ client_cap, tier })

  it('is unlimited when the row carries no cap', () => {
    // A pre-tier subscriber, a trialling coach, an instance with no gateway. None are capped.
    const c = capacity(sub(null, 'legacy'), 40)
    expect(c.cap).toBeNull()
    expect(c.remaining).toBeNull()
    expect(c.full).toBe(false)
  })

  it('is unlimited for a coach with no subscription at all', () => {
    expect(capacity(null, 3).full).toBe(false)
    expect(capacity(undefined, 3).cap).toBeNull()
  })

  it('counts down as clients are taken on', () => {
    expect(capacity(sub(5), 0).remaining).toBe(5)
    expect(capacity(sub(5), 3).remaining).toBe(2)
    expect(capacity(sub(5), 4).full).toBe(false)
  })

  it('is full at the cap, not one past it', () => {
    expect(capacity(sub(5), 5).full).toBe(true)
    expect(capacity(sub(5), 5).remaining).toBe(0)
  })

  it('stays full for a coach left over the line by a downgrade', () => {
    const over = capacity(sub(5), 30)
    expect(over.full).toBe(true)
    // Never negative — this number is rendered, and "-25 remaining" helps nobody.
    expect(over.remaining).toBe(0)
    expect(over.used).toBe(30)
  })

  it('reports the tier it was measured against', () => {
    expect(capacity(sub(25, 'studio'), 1).tier).toBe('studio')
    expect(capacity(null, 0).tier).toBe(DEFAULT_TIER)
  })
})

describe('the way out of a full tier', () => {
  it('offers the next size up', () => {
    expect(nextTierAfter('solo').id).toBe('studio')
    expect(nextTierAfter('studio').id).toBe('pro')
  })

  it('has nothing to offer above the largest', () => {
    expect(nextTierAfter('pro')).toBeNull()
  })

  it('has nothing to offer somebody who is already unlimited', () => {
    expect(nextTierAfter('legacy')).toBeNull()
    expect(nextTierAfter('enterprise')).toBeNull()
  })
})
