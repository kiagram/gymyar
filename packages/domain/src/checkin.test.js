import { describe, it, expect } from 'vitest'
import {
  BUILT_IN_FIELDS, MAX_FIELDS, normaliseField, normaliseFields, fieldsOf,
  normaliseAnswers, missingFrom, checkinDateFor, daysOverdue,
  numericSeries, trendOf, SCALE_DIRECTION
} from './checkin.js'

const fields = [
  { key: 'weight', type: 'bodyweight', label: 'Weight' },
  { key: 'sleep', type: 'scale', label: 'Sleep', required: true },
  { key: 'waist', type: 'measure', label: 'Waist', min: 40, max: 200, unit: 'cm' },
  { key: 'supplements', type: 'bool', label: 'Took them' },
  { key: 'notes', type: 'text', label: 'Notes' },
  { key: 'front', type: 'photo', label: 'Front photo' }
]

describe('a template a coach wrote', () => {
  it('drops a field with no usable key rather than refusing the save', () => {
    const out = normaliseFields([{ key: 'ok', type: 'scale' }, { type: 'scale' }, { key: '9lives' }])
    expect(out.map(f => f.key)).toEqual(['ok'])
  })

  it('keeps the first of two fields sharing a key', () => {
    const out = normaliseFields([
      { key: 'sleep', type: 'scale', label: 'Sleep' },
      { key: 'sleep', type: 'text', label: 'Sleep again' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('scale')
  })

  it('falls back to text for a type it does not know', () => {
    expect(normaliseField({ key: 'k', type: 'interpretive_dance' }).type).toBe('text')
  })

  it('labels a field with its key rather than leaving it blank', () => {
    expect(normaliseField({ key: 'sleep', type: 'scale' }).label).toBe('sleep')
  })

  it('gives bounds only to a measure, and ignores a max under its min', () => {
    expect(normaliseField({ key: 'w', type: 'measure', min: 40, max: 200 }))
      .toMatchObject({ min: 40, max: 200 })
    expect(normaliseField({ key: 'w', type: 'measure', min: 200, max: 40 }).max).toBeUndefined()
    expect(normaliseField({ key: 's', type: 'scale', min: 0, max: 99 }).min).toBeUndefined()
  })

  it('caps how long a weekly form can be', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ key: 'f' + i, type: 'text' }))
    expect(normaliseFields(many)).toHaveLength(MAX_FIELDS)
  })

  it('answers to the built-in set when there is no template at all', () => {
    expect(fieldsOf(null)).toBe(BUILT_IN_FIELDS)
    expect(fieldsOf({ fields: [] })).toBe(BUILT_IN_FIELDS)
    expect(fieldsOf({ fields })).not.toBe(BUILT_IN_FIELDS)
  })
})

describe('answers', () => {
  it('clamps a scale into 1–5 and rounds it', () => {
    expect(normaliseAnswers(fields, { sleep: 11 }).sleep).toBe(5)
    expect(normaliseAnswers(fields, { sleep: 0 }).sleep).toBe(1)
    expect(normaliseAnswers(fields, { sleep: '3.4' }).sleep).toBe(3)
  })

  it('rounds a measurement to a tenth', () => {
    expect(normaliseAnswers(fields, { waist: 81.4732 }).waist).toBe(81.5)
  })

  it('drops a measurement outside the bounds the field declared', () => {
    // A waist of four metres is a typo, and storing it puts a spike in a chart somebody reads.
    expect(normaliseAnswers(fields, { waist: 4000 })).not.toHaveProperty('waist')
    expect(normaliseAnswers(fields, { waist: 39 })).not.toHaveProperty('waist')
  })

  it('leaves an unanswered field absent rather than null', () => {
    const out = normaliseAnswers(fields, { sleep: 4, notes: '', waist: null })
    expect(out).toEqual({ sleep: 4 })
  })

  it('stores nothing for a photo field, whatever is sent for it', () => {
    // The picture is an attachment behind the `photos` scope. A copy here would be a consent
    // decision made twice, and only once properly.
    expect(normaliseAnswers(fields, { front: 'data:image/png;base64,AAAA' }))
      .not.toHaveProperty('front')
  })

  it('keeps an answer to a question the coach has since removed', () => {
    // It is a record of what somebody said. Reordering the form in April cannot un-say March.
    const out = normaliseAnswers(fields, { sleep: 3, stress: 'a lot, actually' })
    expect(out.stress).toBe('a lot, actually')
  })

  it('coerces a bool and truncates a long note', () => {
    expect(normaliseAnswers(fields, { supplements: 'yes' }).supplements).toBe(true)
    expect(normaliseAnswers(fields, { notes: 'x'.repeat(5000) }).notes).toHaveLength(2000)
  })

  it('names the required fields still missing, and a photo is never one of them', () => {
    const required = [...fields, { key: 'front', type: 'photo', required: true }]
    expect(missingFrom(required, {})).toEqual(['sleep'])
    expect(missingFrom(required, { sleep: 4 })).toEqual([])
  })
})

describe('which day a check-in is filed under', () => {
  const saturday = new Date('2026-08-22T12:00:00')   // a Saturday, day 6

  it('is the scheduled weekday inside that week', () => {
    // Week starting Saturday 22 August, due on Monday: 24 August.
    expect(checkinDateFor(saturday, 1).toISOString().slice(0, 10)).toBe('2026-08-24')
    // Due on the first day of the week is that day itself, not a week later.
    expect(checkinDateFor(saturday, 6).toISOString().slice(0, 10)).toBe('2026-08-22')
  })

  it('does not move because the form was filled in late', () => {
    // Answering on Sunday for a Saturday due date still belongs to that week — otherwise a
    // late reply lands in the next week and leaves a hole in the one it was about.
    const monday = new Date('2026-08-17T12:00:00')    // week starting Monday
    expect(checkinDateFor(monday, 6).toISOString().slice(0, 10)).toBe('2026-08-22')
  })

  it('counts a due date as overdue only after its day is over', () => {
    const due = '2026-08-22'
    expect(daysOverdue(due, Date.parse('2026-08-22T09:00:00'))).toBeLessThan(0)
    expect(daysOverdue(due, Date.parse('2026-08-23T09:00:00'))).toBe(0)
    expect(daysOverdue(due, Date.parse('2026-09-05T09:00:00'))).toBe(13)
  })
})

/* ------------------------------------------------- answers read as a series ---- */

const answered = (d, a, at = `${d}T10:00:00Z`) => ({ d, tpl: 't1', a, at })

describe('reading a run of check-ins as numbers', () => {
  it('builds one series per numeric field, oldest first', () => {
    const out = numericSeries([
      answered('2026-08-15', { weight: 81, sleep: 3, notes: 'fine' }),
      answered('2026-08-01', { weight: 83, sleep: 2 }),
      answered('2026-08-08', { weight: 82, sleep: 2 })
    ], fields)

    expect(out.weight.points.map(p => p.v)).toEqual([83, 82, 81])
    expect(out.sleep.points).toHaveLength(3)
    // Text is not a number and never becomes one.
    expect(out.notes).toBeUndefined()
  })

  it('leaves a draft out — a half-filled form is not an answer', () => {
    const out = numericSeries([
      answered('2026-08-01', { weight: 83 }),
      { d: '2026-08-08', tpl: 't1', a: { weight: 60 }, at: null }
    ], fields)
    expect(out.weight.points).toHaveLength(1)
  })

  it('skips a key no field describes, rather than guessing what the number is', () => {
    const out = numericSeries([answered('2026-08-01', { mystery: 44 })], fields)
    expect(out.mystery).toBeUndefined()
  })

  it('still reads a built-in key a coach template stopped asking', () => {
    // The template dropped `sleep`; the answers given under it are still answers.
    const out = numericSeries([answered('2026-08-01', { sleep: 2 })], [
      { key: 'weight', type: 'bodyweight', label: 'Weight' }
    ])
    expect(out.sleep.points).toHaveLength(1)
  })

  it('fixes a direction only for the scales whose meaning is known', () => {
    expect(SCALE_DIRECTION.soreness).toBe('up-bad')
    expect(SCALE_DIRECTION.sleep).toBe('up-good')
    expect(SCALE_DIRECTION.stress).toBeUndefined()
  })
})

describe('the line through a series', () => {
  const weekly = vs => vs.map((v, i) => ({ d: new Date(Date.parse('2026-07-04T12:00:00Z') + i * 7 * 86400000).toISOString().slice(0, 10), v }))

  it('reports a weekly rate in the field’s own units', () => {
    const t = trendOf(weekly([84, 83, 82, 81]))
    expect(t.perWeek).toBeCloseTo(-1, 5)
    expect(t.n).toBe(4)
    expect(t.days).toBe(21)
  })

  it('reports that rate as a share of the mean, so two people compare', () => {
    const heavy = trendOf(weekly([124, 123, 122, 121]))
    const light = trendOf(weekly([64, 63, 62, 61]))
    expect(Math.abs(heavy.pctPerWeek)).toBeLessThan(Math.abs(light.pctPerWeek))
  })

  it('measures against the dates, not against the array', () => {
    // Three weeks between the last two answers. Read as equal steps this is a much steeper line.
    const t = trendOf([
      { d: '2026-07-04', v: 84 }, { d: '2026-07-11', v: 83 }, { d: '2026-08-01', v: 82 }
    ])
    expect(t.perWeek).toBeGreaterThan(-1)
    expect(t.days).toBe(28)
  })

  it('refuses a trend through two points, or through one week', () => {
    expect(trendOf(weekly([84, 82])).perWeek).toBeNull()
    expect(trendOf([
      { d: '2026-07-04', v: 84 }, { d: '2026-07-05', v: 83 }, { d: '2026-07-06', v: 82 }
    ]).perWeek).toBeNull()
  })

  it('still reports the mean and the ends of a series too short to have a slope', () => {
    const t = trendOf(weekly([84, 82]))
    expect(t.mean).toBe(83)
    expect(t.first).toBe(84)
    expect(t.last).toBe(82)
  })

  it('says nothing at all about nothing', () => {
    expect(trendOf([]).n).toBe(0)
    expect(trendOf([]).mean).toBeNull()
  })
})
