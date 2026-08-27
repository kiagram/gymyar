import { describe, it, expect } from 'vitest'
import { wantsPush, withPush } from './push.js'

/* The stored shape is read by two things that cannot see each other — this screen and the API's
 * `wants()` — so what it means has to be unambiguous. Absent is the case almost everybody is in.
 */
describe('what somebody wants', () => {
  it('is everything, for anybody who has never opened the setting', () => {
    for (const S of [{}, { push: null }, { push: true }]) {
      expect(wantsPush(S, 'message')).toBe(true)
      expect(wantsPush(S, 'proposal')).toBe(true)
    }
  })

  it('is nothing, when the whole switch is off', () => {
    expect(wantsPush({ push: false }, 'message')).toBe(false)
    expect(wantsPush({ push: false }, 'accepted')).toBe(false)
  })

  it('is per switch, and one being off leaves the others alone', () => {
    const S = { push: { message: false } }
    expect(wantsPush(S, 'message')).toBe(false)
    expect(wantsPush(S, 'proposal')).toBe(true)
  })

  it('treats accepted and declined as one switch', () => {
    // To the coach waiting on an answer they are the same event with two outcomes.
    expect(wantsPush({ push: { accepted: false, declined: false } }, 'accepted')).toBe(false)
    // Half off is not on — otherwise the switch would render as on and still be silent.
    expect(wantsPush({ push: { declined: false } }, 'accepted')).toBe(false)
  })
})

describe('switching one', () => {
  it('turns a group off, both of its kinds', () => {
    expect(withPush(null, 'accepted', false)).toEqual({ accepted: false, declined: false })
  })

  it('comes back to null when everything is on again', () => {
    // Not an object of `true`s: that would be a decision nobody made, going stale the day a
    // fifth kind is added.
    const off = withPush(null, 'message', false)
    expect(withPush(off, 'message', true)).toBeNull()
  })

  it('leaves the other groups exactly as they were', () => {
    const off = withPush(null, 'message', false)
    const both = withPush(off, 'proposal', false)
    expect(both).toEqual({ message: false, proposal: false })
    expect(withPush(both, 'message', true)).toEqual({ proposal: false })
  })

  it('expands a blanket off before switching one back on', () => {
    // Somebody who turned everything off and then wants messages again should get messages
    // again — and should keep the silence they chose about everything else.
    const next = withPush(false, 'message', true)
    expect(wantsPush({ push: next }, 'message')).toBe(true)
    expect(wantsPush({ push: next }, 'proposal')).toBe(false)
    expect(wantsPush({ push: next }, 'accepted')).toBe(false)
  })

  it('round-trips through the shape the API reads', () => {
    const stored = withPush(null, 'accepted', false)
    expect(stored.accepted).toBe(false)
    expect(stored.declined).toBe(false)
    expect(stored.message).toBeUndefined()
  })
})
