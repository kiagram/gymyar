import { describe, it, expect } from 'vitest'
import { fmtDate } from './format.js'

describe('fmtDate', () => {
  // The coaching screens render server timestamps, not the bare calendar days the rest of the
  // app stores — appending the noon suffix to one produced "Invalid Date" on every proposal.
  it('formats a calendar day', () => {
    expect(fmtDate('2026-08-01')).toMatch(/1/)
  })
  it('formats a full ISO timestamp the same way', () => {
    expect(fmtDate('2026-08-01T18:28:00.000Z')).toBe(fmtDate('2026-08-01'))
  })
  it('formats a Date the same way', () => {
    expect(fmtDate(new Date('2026-08-01T18:28:00Z'))).toBe(fmtDate('2026-08-01'))
  })
  it('never renders the words "Invalid Date"', () => {
    for (const v of ['2026-08-01T18:28:00.000Z', new Date(), '2026-08-01', 'not a date', null, undefined]) {
      expect(String(fmtDate(v))).not.toContain('Invalid Date')
    }
  })
  it('does not shift the day for viewers west of UTC', () => {
    expect(fmtDate('2026-08-01')).toBe(fmtDate('2026-08-01T00:00:00.000Z'))
  })
})
