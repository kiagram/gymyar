/* Sentences the domain leaves unrendered, and who renders them.
 *
 * The review is computed on the server and read on the client, so the language cannot be
 * decided where the numbers are. These pin the contract that makes that work: one computation,
 * any number of languages, and English whenever nobody supplies a translator.
 */
import { describe, it, expect } from 'vitest'
import { msg, exArg, muscleList, say, sayAll } from './messages.js'
import { reviewTraining, proposeAdaptation } from './planner.js'
import { EXIDX } from './exercises.js'

// A translator standing in for a locale pack, plus a fake exercise-name pack.
const pack = {
  '{0} of {1} planned sessions': '{0} از {1} جلسه',
  '{0} has stalled': '{0} در جا زده',
  'Chest': 'سینه', 'Traps': 'ذوزنقه'
}
const fakeT = (s, ...args) => {
  let v = pack[s] || s
  args.forEach((a, i) => { v = v.replaceAll('{' + i + '}', a) })
  return v
}

describe('say', () => {
  it('is the English identity with no translator', () => {
    expect(say(msg('{0} of {1} planned sessions', 3, 12))).toBe('3 of 12 planned sessions')
  })

  it('renders through a translator when given one', () => {
    expect(say(msg('{0} of {1} planned sessions', 3, 12), { t: fakeT })).toBe('3 از 12 جلسه')
  })

  it('leaves an already-rendered string alone', () => {
    // Older clients and log lines both hand plain strings around; neither should break.
    expect(say('already a sentence', { t: fakeT })).toBe('already a sentence')
  })

  it('is empty for nothing', () => {
    expect(say(null)).toBe('')
    expect(say(undefined)).toBe('')
  })

  it('names an exercise with the English name by default', () => {
    expect(say(msg('{0} has stalled', exArg('0025')))).toBe('barbell bench press has stalled')
  })

  it('names an exercise the way the reader sees it elsewhere', () => {
    const exName = ex => (ex?.id === '0025' ? 'پرس سینه هالتر' : ex?.n)
    expect(say(msg('{0} has stalled', exArg('0025')), { t: fakeT, exName }))
      .toBe('پرس سینه هالتر در جا زده')
  })

  it('falls back to the id for an exercise that is not in the library', () => {
    expect(say(msg('{0} has stalled', exArg('nope')))).toBe('nope has stalled')
  })

  it('names each muscle in the reader’s language', () => {
    // 'chest' and 'trapezius' are muscle keys; MUSCLE_NAME turns them into the display names
    // that the locale packs are keyed on, which is what reaches the translator.
    expect(say(msg('for {0}', muscleList(['chest', 'trapezius'])), { t: fakeT }))
      .toBe('for سینه, ذوزنقه')
  })

  it('joins a list the way the language does', () => {
    expect(say(msg('for {0}', muscleList(['chest', 'trapezius'])), { t: fakeT, listSep: '، ' }))
      .toBe('for سینه، ذوزنقه')
  })

  it('truncates the list where the caller asked', () => {
    const four = muscleList(['chest', 'trapezius', 'lats', 'abs', 'glutes'], 2)
    expect(four.muscles).toHaveLength(2)
  })
})

describe('sayAll', () => {
  it('renders only the sentences, leaving other fields as they are', () => {
    const out = sayAll({ title: msg('{0} has stalled', exArg('0025')), severity: 'high', n: 3 })
    expect(out.title).toBe('barbell bench press has stalled')
    expect(out.severity).toBe('high')
    expect(out.n).toBe(3)
  })
})

describe('what the review hands back', () => {
  const day = i => '2026-08-' + String(10 + i).padStart(2, '0')
  const session = i => ({
    id: 'w' + i, d: day(i), start: Date.parse(day(i)), end: Date.parse(day(i)) + 3.6e6,
    entries: [{ id: '0025', sets: Array.from({ length: 5 }, () => ({ done: true, w: 80, r: 4 })) }]
  })
  const S = {
    week: { 1: 'r1', 3: 'r1', 5: 'r1' },
    routines: [{ id: 'r1', name: 'Push', ex: [{ id: '0025', sets: 5, reps: 5, policy: 'linear' }] }],
    workouts: [session(1), session(2), session(3), session(4)]
  }

  it('leaves every finding unrendered', () => {
    const { findings } = reviewTraining(S, { today: '2026-08-16' })
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) {
      expect(typeof f.title.msg).toBe('string')
      expect(Array.isArray(f.title.args)).toBe(true)
      expect(typeof f.detail.msg).toBe('string')
    }
  })

  it('produces the same numbers in either language', () => {
    const { findings } = reviewTraining(S, { today: '2026-08-16' })
    const attendance = findings.find(f => f.kind === 'attendance')
    expect(say(attendance.title)).toBe('4 of 12 planned sessions')
    expect(say(attendance.title, { t: fakeT })).toBe('4 از 12 جلسه')
  })

  it('leaves the adaptation’s reasons unrendered too', () => {
    const change = proposeAdaptation(S, reviewTraining(S, { today: '2026-08-16' }))
    expect(change).toBeTruthy()
    expect(typeof change.headline.msg === 'string' || typeof change.headline === 'string').toBe(true)
    for (const c of change.changes) expect(typeof c.why.msg).toBe('string')
  })

  it('never leaks an object where a sentence was expected', () => {
    // The bug this guards: rendering a message object into JSX prints [object Object].
    const { findings } = reviewTraining(S, { today: '2026-08-16' })
    for (const f of findings) {
      expect(String(say(f.title))).not.toContain('[object')
      expect(String(say(f.detail))).not.toContain('[object')
    }
  })
})
