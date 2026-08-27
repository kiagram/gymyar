import { describe, it, expect, afterEach } from 'vitest'
import { setI18n } from '@gymyar/domain'
import { BUILT_IN, currentCheckin, saveCheckin, stillMissing } from './checkins.js'

afterEach(() => setI18n(null))

const FIELDS = [
  { key: 'sleep', type: 'scale', label: 'Sleep', required: true },
  { key: 'waist', type: 'measure', label: 'Waist', min: 40, max: 200 },
  { key: 'notes', type: 'text', label: 'Notes' }
]
// Monday 17 August 2026; the week runs to Sunday the 23rd under the default Monday start.
const MON = '2026-08-17'

describe('which day the answer is filed under', () => {
  it('is the weekday the coach asked for, inside this week', () => {
    // Saturday of the week containing Monday the 17th is the 22nd.
    const { date } = currentCheckin({}, { weekday: 6 }, MON)
    expect(date).toBe('2026-08-22')
  })

  it('does not move when the form is opened on a later day', () => {
    // Answering on Sunday for a Saturday due date edits Saturday's row, not Sunday's — else
    // one week gets two check-ins and the next gets none.
    expect(currentCheckin({}, { weekday: 6 }, '2026-08-23').date).toBe('2026-08-22')
    expect(currentCheckin({}, { weekday: 6 }, MON).date).toBe('2026-08-22')
  })

  it('uses the week\'s own first day when nobody scheduled one', () => {
    expect(currentCheckin({}, BUILT_IN, '2026-08-19').date).toBe(MON)
  })

  it('follows the reader\'s week, not a fixed Monday', () => {
    setI18n({ dateLocale: () => 'fa-IR', weekStartsOn: () => 6 })
    // Under a Saturday start, the week containing Monday the 17th begins on the 15th.
    expect(currentCheckin({}, BUILT_IN, MON).date).toBe('2026-08-15')
  })

  it('finds an answer already given for that day', () => {
    const S = { checkins: [{ d: '2026-08-22', a: { sleep: 4 }, at: '2026-08-22T09:00:00.000Z' }] }
    const cur = currentCheckin(S, { weekday: 6 }, MON)
    expect(cur.answers).toEqual({ sleep: 4 })
    expect(cur.submitted).toBe(true)
  })

  it('reports a draft as not submitted', () => {
    const S = { checkins: [{ d: '2026-08-22', a: { notes: 'half' }, at: null }] }
    expect(currentCheckin(S, { weekday: 6 }, MON).submitted).toBe(false)
  })
})

describe('saving', () => {
  it('writes a new answer, shaped by the questions', () => {
    const S = { checkins: [] }
    saveCheckin(S, { date: '2026-08-22', templateId: 't1', fields: FIELDS, answers: { sleep: 11, waist: 4000 } })
    expect(S.checkins[0].a).toEqual({ sleep: 5 })     // clamped, and the waist dropped
    expect(S.checkins[0].tpl).toBe('t1')
    expect(S.checkins[0].at).toBeTruthy()
  })

  it('keeps a draft unsubmitted', () => {
    const S = { checkins: [] }
    saveCheckin(S, { date: '2026-08-22', fields: FIELDS, answers: { notes: 'later' }, submit: false })
    expect(S.checkins[0].at).toBeNull()
  })

  it('edits the same row rather than adding a second one for that day', () => {
    const S = { checkins: [] }
    saveCheckin(S, { date: '2026-08-22', fields: FIELDS, answers: { sleep: 3 } })
    saveCheckin(S, { date: '2026-08-22', fields: FIELDS, answers: { sleep: 5 } })
    expect(S.checkins).toHaveLength(1)
    expect(S.checkins[0].a.sleep).toBe(5)
  })

  it('does not un-submit an answer that is being added to', () => {
    // Reopening last Saturday to add a sentence is not withdrawing what was already said.
    const S = { checkins: [] }
    saveCheckin(S, { date: '2026-08-22', fields: FIELDS, answers: { sleep: 4 } })
    const sent = S.checkins[0].at
    saveCheckin(S, { date: '2026-08-22', fields: FIELDS, answers: { sleep: 4, notes: 'and' }, submit: false })
    expect(S.checkins[0].at).toBe(sent)
    expect(S.checkins[0].a.notes).toBe('and')
  })

  it('keeps the list in date order', () => {
    const S = { checkins: [] }
    saveCheckin(S, { date: '2026-08-22', fields: FIELDS, answers: { sleep: 4 } })
    saveCheckin(S, { date: '2026-08-15', fields: FIELDS, answers: { sleep: 3 } })
    expect(S.checkins.map(c => c.d)).toEqual(['2026-08-15', '2026-08-22'])
  })
})

describe('what is still missing', () => {
  it('names a required question with no answer', () => {
    expect(stillMissing(FIELDS, {})).toEqual(['sleep'])
    expect(stillMissing(FIELDS, { sleep: 3 })).toEqual([])
  })
})
