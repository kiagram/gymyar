import { describe, it, expect } from 'vitest'
import {
  entitlement, allows, extend, addMonths, trialEnd, TRIAL_DAYS, GRACE_DAYS
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
