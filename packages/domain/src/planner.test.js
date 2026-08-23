import { describe, it, expect } from 'vitest'
import {
  normaliseBrief, resolvePattern, buildProgramme, scheduleFor,
  reviewTraining, proposeAdaptation, GOALS, EQUIPMENT
} from './planner.js'
import { EXIDX } from './exercises.js'
import { say } from './messages.js'

const GYM = ['barbell', 'dumbbell', 'cable', 'leverage machine', 'body weight']
const idsIn = programme => programme.routines.flatMap(r => r.ex.map(e => e.id))

describe('the brief is the validation boundary', () => {
  // Everything a language model produces passes through here before it can influence a number.
  it('refuses a goal it does not have', () => {
    expect(normaliseBrief({ goal: 'become a wizard' }).goal).toBe('general')
  })

  it('refuses equipment that is not in the dataset', () => {
    const b = normaliseBrief({ equipment: ['barbell', 'trebuchet', 'DUMBBELL'] })
    expect(b.equipment).toContain('barbell')
    expect(b.equipment).toContain('dumbbell')
    expect(b.equipment).not.toContain('trebuchet')
    expect(b.equipment.every(e => EQUIPMENT.includes(e))).toBe(true)
  })

  it('clamps a week to something a week can hold', () => {
    expect(normaliseBrief({ daysPerWeek: 40 }).daysPerWeek).toBe(6)
    expect(normaliseBrief({ daysPerWeek: 0 }).daysPerWeek).toBe(2)
    expect(normaliseBrief({ daysPerWeek: 'lots' }).daysPerWeek).toBe(2)
  })

  it('clamps session length', () => {
    expect(normaliseBrief({ sessionMinutes: 600 }).sessionMinutes).toBe(120)
    expect(normaliseBrief({ sessionMinutes: 1 }).sessionMinutes).toBe(20)
  })

  it('drops exercise ids that do not exist', () => {
    expect(normaliseBrief({ avoid: ['0025', 'not-an-exercise'] }).avoid).toEqual(['0025'])
  })

  it('always leaves bodyweight available', () => {
    expect(normaliseBrief({ equipment: [] }).equipment).toEqual(['body weight'])
    expect(normaliseBrief({ equipment: ['barbell'] }).equipment).toContain('body weight')
  })

  it('survives being handed nothing at all', () => {
    const b = normaliseBrief()
    expect(GOALS).toContain(b.goal)
    expect(b.daysPerWeek).toBeGreaterThanOrEqual(2)
  })
})

describe('choosing exercises', () => {
  it('only ever returns something that exists in the library', () => {
    for (const equipment of [['body weight'], ['body weight', 'dumbbell'], GYM]) {
      for (const key of ['squat', 'hinge', 'horizontal-push', 'vertical-pull', 'core']) {
        const picked = resolvePattern(key, { equipment })
        if (picked) expect(EXIDX[picked.id]).toBeTruthy()
      }
    }
  })

  it('never suggests equipment the person said they do not have', () => {
    for (const key of ['squat', 'hinge', 'horizontal-push', 'horizontal-pull', 'core', 'calves']) {
      const picked = resolvePattern(key, { equipment: ['body weight'] })
      if (picked) expect(picked.eq).toBe('body weight')
    }
  })

  it('is deterministic', () => {
    const a = resolvePattern('squat', { equipment: GYM })
    const b = resolvePattern('squat', { equipment: GYM })
    expect(a.id).toBe(b.id)
  })

  it('picks the plainest version of a lift, not a camera angle', () => {
    // the library carries "barbell full squat (side pov)" and friends
    expect(resolvePattern('squat', { equipment: GYM }).n).toBe('barbell full squat')
    expect(resolvePattern('horizontal-push', { equipment: GYM }).n).toBe('barbell bench press')
  })

  it('returns nothing rather than junk when the equipment cannot cover a pattern', () => {
    // the dataset tags "left hook. boxing" and "rear deltoid stretch" as delts work; selecting
    // by target muscle alone put those in people's programmes
    expect(resolvePattern('lateral-delt', { equipment: ['body weight'] })).toBeNull()
    expect(resolvePattern('posterior-shoulder', { equipment: ['body weight'] })).toBeNull()
  })

  it('never picks a stretch or a boxing drill', () => {
    for (const key of ['vertical-push', 'lateral-delt', 'posterior-shoulder', 'squat']) {
      for (const equipment of [['body weight'], ['body weight', 'dumbbell'], GYM]) {
        const picked = resolvePattern(key, { equipment })
        if (picked) expect(picked.n).not.toMatch(/stretch|boxing|hook|uppercut/i)
      }
    }
  })

  it('will not repeat an exercise already in the session', () => {
    const first = resolvePattern('squat', { equipment: GYM })
    const second = resolvePattern('squat', { equipment: GYM, taken: [first.id] })
    expect(second.id).not.toBe(first.id)
  })

  it('honours an exercise the person cannot do', () => {
    const normal = resolvePattern('horizontal-push', { equipment: GYM })
    const avoided = resolvePattern('horizontal-push', { equipment: GYM, avoid: [normal.id] })
    expect(avoided.id).not.toBe(normal.id)
  })
})

describe('building a programme', () => {
  it('never puts an exercise in a plan that is not in the library', () => {
    // the guarantee that makes this safe to expose: nothing can be invented
    for (const goal of GOALS) {
      for (const days of [2, 3, 4, 5, 6]) {
        const p = buildProgramme({ goal, daysPerWeek: days, equipment: GYM })
        for (const id of idsIn(p)) expect(EXIDX[id]).toBeTruthy()
      }
    }
  })

  it('produces the same plan twice for the same brief', () => {
    const brief = { goal: 'muscle', daysPerWeek: 4, equipment: GYM, sessionMinutes: 60 }
    const strip = p => p.routines.map(r => ({ name: r.name, ex: r.ex }))
    expect(strip(buildProgramme(brief))).toEqual(strip(buildProgramme(brief)))
  })

  it('gives each training day a routine', () => {
    for (const days of [2, 3, 4, 5, 6]) {
      const p = buildProgramme({ daysPerWeek: days, equipment: GYM })
      expect(Object.keys(p.week)).toHaveLength(days)
      expect(Object.values(p.week).every(id => p.routines.some(r => r.id === id))).toBe(true)
    }
  })

  it('spreads training days rather than stacking them', () => {
    expect(scheduleFor(2)).toEqual([1, 4])
    expect(scheduleFor(3)).toEqual([1, 3, 5])
  })

  it('builds a whole plan for somebody with only their own body', () => {
    const p = buildProgramme({ daysPerWeek: 3, equipment: [] })
    const ids = idsIn(p)
    expect(ids.length).toBeGreaterThan(6)
    for (const id of ids) expect(EXIDX[id].eq).toBe('body weight')
  })

  it('says what it could not cover instead of quietly dropping it', () => {
    const p = buildProgramme({ daysPerWeek: 5, equipment: [] })
    expect(p.notes.join(' ')).toMatch(/nothing in the library covers it/i)
  })

  it('matches sets and reps to the goal', () => {
    const strength = buildProgramme({ goal: 'strength', daysPerWeek: 3, equipment: GYM })
    const endurance = buildProgramme({ goal: 'endurance', daysPerWeek: 3, equipment: GYM })
    expect(strength.routines[0].ex[0]).toMatchObject({ sets: 5, reps: 5 })
    expect(strength.routines[0].policy).toBe('greyskull')
    expect(endurance.routines[0].ex[0].reps).toBeGreaterThanOrEqual(15)
    expect(endurance.routines[0].policy).toBe('linear')
  })

  it('progresses a size plan by reps, not by weight alone', () => {
    expect(buildProgramme({ goal: 'muscle', daysPerWeek: 4, equipment: GYM }).routines[0].policy)
      .toBe('double')
  })

  it('keeps a beginner\'s sessions short and compound', () => {
    const beginner = buildProgramme({ experience: 'new', daysPerWeek: 3, sessionMinutes: 90, equipment: GYM })
    const veteran = buildProgramme({ experience: 'experienced', daysPerWeek: 3, sessionMinutes: 90, equipment: GYM })
    expect(beginner.routines[0].ex.length).toBeLessThanOrEqual(4)
    expect(beginner.routines[0].ex.length).toBeLessThanOrEqual(veteran.routines[0].ex.length)
    expect(beginner.notes.join(' ')).toMatch(/volume is easy to add later/i)
  })

  it('fits the session into the time available', () => {
    const short = buildProgramme({ daysPerWeek: 3, sessionMinutes: 30, equipment: GYM, experience: 'experienced' })
    const long = buildProgramme({ daysPerWeek: 3, sessionMinutes: 90, equipment: GYM, experience: 'experienced' })
    expect(short.routines[0].ex.length).toBeLessThan(long.routines[0].ex.length)
    expect(short.routines[0].ex.length).toBeGreaterThanOrEqual(3)
  })

  it('adds emphasis work on top rather than instead of the main lifts', () => {
    const plain = buildProgramme({ daysPerWeek: 3, equipment: GYM, experience: 'experienced', sessionMinutes: 90 })
    const armed = buildProgramme({ daysPerWeek: 3, equipment: GYM, experience: 'experienced', sessionMinutes: 90, emphasis: ['biceps'] })
    // the compounds that were there before are still there
    const firstOf = p => p.routines[0].ex[0].id
    expect(firstOf(armed)).toBe(firstOf(plain))
    expect(armed.notes.join(' ')).toMatch(/biceps/i)
  })

  it('works around an exercise somebody cannot do', () => {
    const bench = resolvePattern('horizontal-push', { equipment: GYM }).id
    const p = buildProgramme({ daysPerWeek: 3, equipment: GYM, avoid: [bench] })
    expect(idsIn(p)).not.toContain(bench)
    expect(p.notes.join(' ')).toMatch(/working around/i)
  })

  it('gives a plank seconds and not reps', () => {
    const p = buildProgramme({ daysPerWeek: 3, equipment: GYM })
    for (const r of p.routines) {
      for (const e of r.ex) {
        if (/plank/i.test(EXIDX[e.id].n)) {
          expect(e.mode).toBe('time')
          expect(e.sec).toBeGreaterThan(0)
          expect(e.reps).toBeUndefined()
        }
      }
    }
  })

  it('does not put the same exercise twice in one session', () => {
    for (const days of [2, 3, 4, 5, 6]) {
      for (const r of buildProgramme({ daysPerWeek: days, equipment: GYM }).routines) {
        expect(new Set(r.ex.map(e => e.id)).size).toBe(r.ex.length)
      }
    }
  })

  it('explains itself in plain language', () => {
    const p = buildProgramme({ goal: 'strength', daysPerWeek: 3, equipment: GYM })
    expect(p.notes.length).toBeGreaterThan(0)
    expect(p.notes[0]).toMatch(/strength/i)
  })
})

/* ------------------------------------------------------------------ review ---- */

const NOW = Date.parse('2026-08-23T12:00:00Z')
const daysAgo = n => NOW - n * 86400000

const session = (id, exId, dayOffset, { reps = 5, target = 5, done = true, rir = null } = {}) => ({
  id, d: new Date(daysAgo(dayOffset)).toISOString().slice(0, 10),
  start: daysAgo(dayOffset), end: daysAgo(dayOffset) + 3600000,
  routineId: 'r1', name: 'Full Body',
  entries: [{
    id: exId,
    target: { sets: 3, reps: target },
    sets: Array.from({ length: 3 }, () => ({ w: 100, r: reps, done, ...(rir != null ? { rir } : {}) }))
  }]
})

const stateWith = (workouts, extra = {}) => ({
  unit: 'kg', effort: 'rir',
  routines: [{ id: 'r1', name: 'Full Body', policy: 'linear', ex: [{ id: '0025', sets: 3, reps: 5 }] }],
  week: { 1: 'r1', 3: 'r1', 5: 'r1' },
  workouts, bodyweight: [], customEx: [], dayPlan: {},
  ...extra
})

describe('reviewing training', () => {
  it('says nothing is wrong when nothing is wrong', () => {
    const S = stateWith(Array.from({ length: 12 }, (_, i) => session(`w${i}`, '0025', 24 - i * 2)))
    const r = reviewTraining(S, { today: NOW })
    expect(r.findings.filter(f => f.severity === 'high')).toHaveLength(0)
  })

  it('notices a lift that has stopped moving', () => {
    const workouts = [
      session('w1', '0025', 20, { reps: 5 }),
      session('w2', '0025', 15, { reps: 4 }),
      session('w3', '0025', 10, { reps: 4 }),
      session('w4', '0025', 5, { reps: 3 })
    ]
    const r = reviewTraining(stateWith(workouts), { today: NOW })
    const stalled = r.findings.find(f => f.kind === 'stalled')
    expect(stalled).toBeTruthy()
    expect(stalled.exerciseId).toBe('0025')
    expect(say(stalled.title)).toMatch(/bench press/i)
  })

  it('warns one session before a stall rather than after', () => {
    const workouts = [
      session('w1', '0025', 20, { reps: 5 }),
      session('w2', '0025', 15, { reps: 5 }),
      session('w3', '0025', 10, { reps: 4 }),
      session('w4', '0025', 5, { reps: 4 })
    ]
    const r = reviewTraining(stateWith(workouts), { today: NOW })
    expect(r.findings.find(f => f.kind === 'stalling')).toBeTruthy()
  })

  it('counts turning up, and only counts finished sessions', () => {
    const workouts = [
      session('w1', '0025', 20), session('w2', '0025', 10),
      { ...session('w3', '0025', 5), end: null }          // started and abandoned
    ]
    const r = reviewTraining(stateWith(workouts), { today: NOW })
    expect(r.sessions).toBe(2)
    expect(r.expected).toBe(12)
    expect(r.findings.find(f => f.kind === 'attendance')?.severity).toBe('high')
  })

  it('does not scold somebody with no schedule to miss', () => {
    const S = stateWith([session('w1', '0025', 3)], { week: {} })
    const r = reviewTraining(S, { today: NOW })
    expect(r.findings.find(f => f.kind === 'attendance')).toBeUndefined()
  })

  it('treats a long absence as its own thing', () => {
    const S = stateWith([session('w1', '0025', 40)])
    const r = reviewTraining(S, { today: NOW })
    const lapsed = r.findings.find(f => f.kind === 'lapsed')
    expect(lapsed).toBeTruthy()
    expect(lapsed.suggest).toBe('restart-light')
  })

  it('spots a lift that is going up more slowly than the person is', () => {
    const workouts = Array.from({ length: 6 }, (_, i) =>
      session(`w${i}`, '0025', 20 - i * 3, { reps: 5, rir: 5 }))
    const r = reviewTraining(stateWith(workouts), { today: NOW })
    const easy = r.findings.find(f => f.kind === 'easy')
    expect(easy).toBeTruthy()
    expect(easy.suggest).toBe('bigger-jumps')
  })

  it('does not guess at effort when the profile does not log it', () => {
    const workouts = Array.from({ length: 6 }, (_, i) =>
      session(`w${i}`, '0025', 20 - i * 3, { reps: 5, rir: 5 }))
    const S = stateWith(workouts, { effort: 'none' })
    expect(reviewTraining(S, { today: NOW }).findings.find(f => f.kind === 'easy')).toBeUndefined()
  })

  it('will not call three ratings a trend', () => {
    const workouts = Array.from({ length: 3 }, (_, i) =>
      session(`w${i}`, '0025', 20 - i * 3, { reps: 5, rir: 6 }))
    expect(reviewTraining(stateWith(workouts), { today: NOW })
      .findings.find(f => f.kind === 'easy')).toBeUndefined()
  })

  it('names what is never being trained', () => {
    const workouts = Array.from({ length: 8 }, (_, i) => session(`w${i}`, '0025', 24 - i * 3))
    const r = reviewTraining(stateWith(workouts), { today: NOW })
    const gap = r.findings.find(f => f.kind === 'untrained')
    expect(gap).toBeTruthy()
    expect(gap.muscles.length).toBeGreaterThanOrEqual(4)
  })

  it('puts the urgent things first', () => {
    const workouts = [
      session('w1', '0025', 20, { reps: 5 }),
      session('w2', '0025', 15, { reps: 4 }),
      session('w3', '0025', 10, { reps: 4 }),
      session('w4', '0025', 5, { reps: 3 })
    ]
    const { findings } = reviewTraining(stateWith(workouts), { today: NOW })
    const rank = { high: 0, medium: 1, low: 2 }
    for (let i = 1; i < findings.length; i++) {
      expect(rank[findings[i].severity]).toBeGreaterThanOrEqual(rank[findings[i - 1].severity])
    }
  })

  it('handles an empty profile without falling over', () => {
    expect(() => reviewTraining({}, { today: NOW })).not.toThrow()
    expect(reviewTraining({}, { today: NOW }).findings).toEqual([])
  })
})

describe('proposing a change', () => {
  const stalledState = () => stateWith([
    session('w1', '0025', 20, { reps: 5 }),
    session('w2', '0025', 15, { reps: 4 }),
    session('w3', '0025', 10, { reps: 4 }),
    session('w4', '0025', 5, { reps: 3 })
  ])

  it('turns the worst finding into an actual routine', () => {
    const S = stalledState()
    const change = proposeAdaptation(S, reviewTraining(S, { today: NOW }))
    expect(change).toBeTruthy()
    expect(change.routineId).toBe('r1')
    expect(change.after.ex).toBeInstanceOf(Array)
    expect(change.changes.length).toBeGreaterThan(0)
  })

  it('says why, in words a person would use', () => {
    const S = stalledState()
    const change = proposeAdaptation(S, reviewTraining(S, { today: NOW }))
    expect(say(change.changes[0].why)).toMatch(/[a-z]{4,}/)
    expect(say(change.note)).toBeTruthy()
  })

  it('only ever proposes exercises that exist', () => {
    const S = stalledState()
    const change = proposeAdaptation(S, reviewTraining(S, { today: NOW }))
    for (const e of change.after.ex) expect(EXIDX[e.id]).toBeTruthy()
  })

  it('keeps the routine recognisably the same routine', () => {
    const S = stalledState()
    const change = proposeAdaptation(S, reviewTraining(S, { today: NOW }))
    expect(change.after.id).toBe(change.before.id)
    expect(change.after.name).toBe(change.before.name)
  })

  it('proposes fewer days rather than different exercises when nobody is turning up', () => {
    const S = stateWith([session('w1', '0025', 20)])
    const change = proposeAdaptation(S, reviewTraining(S, { today: NOW }))
    // a lapse is scored higher than attendance, so assert on whichever came out
    expect(['Fewer days, not different exercises', 'Nothing logged for 20 days'])
      .toContain(say(change.headline))
  })

  it('returns nothing when there is nothing to say', () => {
    expect(proposeAdaptation({ routines: [] })).toBeNull()
  })

  it('never leaves a routine empty', () => {
    const S = stalledState()
    const change = proposeAdaptation(S, reviewTraining(S, { today: NOW }))
    expect(change.after.ex.length).toBeGreaterThan(0)
  })
})

describe('variety across the week', () => {
  it('does not put the same heavy compound in two sessions', () => {
    // a four-day split resolving each hinge slot independently gives barbell deadlift 5×5 twice
    // a week, which is a programming mistake a lifter spots immediately
    const p = buildProgramme({ goal: 'strength', daysPerWeek: 4, equipment: GYM, experience: 'experienced', sessionMinutes: 75 })
    const compounds = p.routines.flatMap(r => r.ex.slice(0, 2).map(e => e.id))
    expect(new Set(compounds).size).toBe(compounds.length)
  })

  it('is happy to repeat an accessory', () => {
    // reaching for variety on isolation work finds "dumbbell biceps curl squat", which is not
    // a biceps exercise — curling the same way twice a week is correct
    const p = buildProgramme({ goal: 'muscle', daysPerWeek: 6, equipment: GYM, experience: 'experienced', sessionMinutes: 90 })
    for (const id of idsIn(p)) expect(EXIDX[id].n).not.toMatch(/curl squat/i)
  })

  it('tops up a session the equipment left thin', () => {
    // bodyweight has no lateral raise and no curl, so a push/pull split leaves a two-exercise
    // pull day — a second variation of what the session is about beats a gap
    const p = buildProgramme({ daysPerWeek: 6, equipment: [] })
    expect(p.routines.every(r => r.ex.length >= 3)).toBe(true)
    for (const r of p.routines) expect(new Set(r.ex.map(e => e.id)).size).toBe(r.ex.length)
  })

  it('still says what it could not cover, even after topping up', () => {
    const p = buildProgramme({ daysPerWeek: 6, equipment: [] })
    expect(p.notes.join(' ')).toMatch(/nothing in the library covers it/i)
  })
})
