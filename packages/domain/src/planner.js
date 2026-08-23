/* Programme generation and training review — deterministic, offline, no model involved.
 *
 * Why this is not an LLM
 * ---------------------
 * The temptation with "AI programming" is to hand a language model the goal and let it write the
 * whole plan. That is the wrong tool twice over. Sets, reps, loads and progression steps are
 * arithmetic this codebase already does correctly and tests thoroughly — `progression.js` knows
 * what Greyskull does after a missed AMRAP, and a model does not. And a model asked for exercises
 * will cheerfully invent ones that are not in the library, or put 140 kg on the bar of somebody
 * who has never squatted, and neither failure is acceptable in something people load a barbell
 * from.
 *
 * So the division of labour is: **this file owns every number, the model owns language.** It turns
 * "I want to get stronger, three days a week, I've only got dumbbells" into a structured brief and
 * writes the sentence explaining a change. The plan itself is built here, from the real library,
 * against the real progression policies. A model with no key configured costs the product its
 * phrasing, not its function.
 *
 * Everything here is pure: same brief in, same programme out, every time.
 */
import { EXDB, EXIDX } from './exercises.js'
import { uid } from './format.js'
import { modeOf, effortOf } from './history.js'
import { sessionsFor, stallCount, DELOAD_AFTER, policyFor } from './progression.js'
import { loadOfWorkouts, MUSCLE_NAME } from './muscles.js'
import { msg, exArg, muscleList } from './messages.js'

/* ------------------------------------------------------------------ brief ---- */

export const GOALS = ['strength', 'muscle', 'general', 'endurance']
export const EXPERIENCE = ['new', 'returning', 'experienced']

/** Equipment a brief may claim, as the dataset spells it. */
export const EQUIPMENT = [
  'body weight', 'dumbbell', 'barbell', 'cable', 'leverage machine', 'band',
  'smith machine', 'kettlebell', 'ez barbell', 'stability ball', 'medicine ball',
  'assisted', 'sled machine', 'rope', 'trap bar', 'olympic barbell', 'weighted'
]

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)))
const uniq = xs => [...new Set(xs)]

/**
 * Coerce anything into a brief the planner will accept.
 *
 * This is also the validation boundary for model output: a brief that came out of a language
 * model goes through here before it can influence a single number, so an invented goal, a
 * hallucinated piece of equipment or "train 40 days a week" cannot reach the planner.
 */
export function normaliseBrief(input = {}) {
  const equipment = uniq((Array.isArray(input.equipment) ? input.equipment : [])
    .map(e => String(e).toLowerCase().trim())
    .filter(e => EQUIPMENT.includes(e)))
  return {
    goal: GOALS.includes(input.goal) ? input.goal : 'general',
    experience: EXPERIENCE.includes(input.experience) ? input.experience : 'returning',
    daysPerWeek: clamp(input.daysPerWeek ?? 3, 2, 6),
    sessionMinutes: clamp(input.sessionMinutes ?? 60, 20, 120),
    // Bodyweight is always available — a plan that assumes a rack and finds none is useless,
    // and everyone has the floor.
    equipment: equipment.length ? uniq(['body weight', ...equipment]) : ['body weight'],
    emphasis: uniq((Array.isArray(input.emphasis) ? input.emphasis : [])
      .map(m => String(m).toLowerCase().trim())
      .filter(m => Object.keys(MUSCLE_NAME).includes(m))),
    avoid: uniq((Array.isArray(input.avoid) ? input.avoid : [])
      .map(String).filter(id => EXIDX[id]))
  }
}

/* --------------------------------------------------------------- patterns ---- */

/* Movement patterns, resolved against the live library rather than pinned to ids.
 *
 * `prefer` is an ordered list of name fragments and a candidate must match one of them — the
 * match is not a tie-break, it is the filter. That strictness is deliberate. Selecting by target
 * muscle alone produces "left hook. boxing" for an overhead press and "rear deltoid stretch" for
 * rear delts, because the dataset tags both with `delts`. Requiring a named match means every
 * pick was written down by a person, and a pattern nobody can equip resolves to nothing at all —
 * which the planner reports honestly rather than filling with junk.
 *
 * Resolving by name against the live data rather than by hardcoded id also means a library
 * update can never leave a pattern pointing at an exercise that no longer exists.
 */
const PATTERNS = {
  'horizontal-push': {
    label: 'Horizontal press', targets: ['pectorals'], compound: true,
    prefer: ['barbell bench press', 'dumbbell bench press', 'smith bench press',
             'lever chest press', 'push-up', 'chest dip']
  },
  'vertical-push': {
    label: 'Overhead press', targets: ['delts'], compound: true,
    prefer: ['barbell standing wide military press', 'barbell seated overhead press',
             'dumbbell standing overhead press', 'dumbbell seated shoulder press',
             'lever shoulder press', 'handstand push-up']
  },
  'horizontal-pull': {
    label: 'Row', targets: ['upper back', 'lats'], compound: true,
    prefer: ['barbell bent over row', 'dumbbell bent over row', 'cable seated row',
             'lever seated row', 'inverted row']
  },
  'vertical-pull': {
    label: 'Pull-down', targets: ['lats', 'upper back'], compound: true,
    prefer: ['pull-up', 'chin-up', 'cable pulldown', 'lever pulldown', 'assisted pull-up']
  },
  squat: {
    label: 'Squat', targets: ['quads', 'glutes'], compound: true,
    prefer: ['barbell full squat', 'barbell front squat', 'dumbbell goblet squat',
             'lever leg press', 'sissy squat', 'split squats']
  },
  hinge: {
    label: 'Hinge', targets: ['glutes', 'hamstrings'], compound: true,
    prefer: ['barbell deadlift', 'barbell romanian deadlift', 'dumbbell romanian deadlift',
             'lever deadlift', 'low glute bridge on floor', 'glute bridge']
  },
  lunge: {
    label: 'Single-leg', targets: ['quads', 'glutes'], compound: true,
    prefer: ['dumbbell lunge', 'barbell lunge', 'dumbbell bulgarian split squat',
             'split squats', 'step-up']
  },
  'lateral-delt': {
    label: 'Lateral raise', targets: ['delts'],
    prefer: ['dumbbell lateral raise', 'cable lateral raise', 'band lateral raise',
             'lever lateral raise']
  },
  biceps: {
    label: 'Biceps', targets: ['biceps'],
    prefer: ['dumbbell biceps curl', 'barbell curl', 'ez barbell curl', 'cable curl',
             'dumbbell hammer curl']
  },
  triceps: {
    label: 'Triceps', targets: ['triceps'],
    prefer: ['cable pushdown', 'triceps pushdown', 'dumbbell lying triceps extension',
             'barbell lying triceps extension', 'dumbbell kickback', 'bench dip']
  },
  calves: {
    label: 'Calves', targets: ['calves'],
    prefer: ['lever standing calf raise', 'barbell standing calf raise',
             'dumbbell standing calf raise', 'bodyweight standing calf raise']
  },
  core: {
    label: 'Core', targets: ['abs'],
    prefer: ['weighted front plank', 'power point plank', 'front plank', 'hanging leg raise',
             'cable crunch', 'crunch']
  },
  'posterior-shoulder': {
    label: 'Rear delts', targets: ['delts', 'upper back'],
    prefer: ['dumbbell rear delt raise', 'dumbbell rear delt row', 'cable rear delt',
             'band reverse fly']
  }
}

/**
 * The best available exercise for a pattern, or null when the equipment cannot cover it.
 *
 * Deterministic by construction: preference index first, then whether the pattern's muscle is the
 * primary target, then the shortest name (which picks "barbell bench press" over
 * "barbell bench press (back pov)"), then the id. Two identical briefs produce byte-identical
 * programmes — which is what makes this testable, and what stops "regenerate" being a slot machine.
 */
export function resolvePattern(key, { equipment, avoid = [], taken = [] } = {}) {
  const pattern = PATTERNS[key]
  if (!pattern) return null
  const allowed = new Set(equipment && equipment.length ? equipment : EQUIPMENT)
  const skip = new Set([...avoid, ...taken])

  const scored = []
  for (const e of EXDB) {
    if (skip.has(e.id) || !allowed.has(e.eq)) continue
    const name = e.n.toLowerCase()
    const idx = pattern.prefer.findIndex(p => name.includes(p))
    if (idx === -1) continue                          // no named match: not a candidate at all
    scored.push([[idx, pattern.targets.includes(e.tg) ? 0 : 1, e.n.length, e.id], e])
  }
  if (!scored.length) return null

  scored.sort(([a], [b]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return 0
  })
  return scored[0][1]
}

/* ----------------------------------------------------------------- splits ---- */

/* Which sessions a week is made of. Two days cannot support a body-part split, six can; the
 * shapes in between are the standard answers rather than anything clever. */
const SPLITS = {
  2: [
    { name: 'Full Body A', glyph: 'figureStrength', patterns: ['squat', 'horizontal-push', 'horizontal-pull', 'core'] },
    { name: 'Full Body B', glyph: 'figureStrength', patterns: ['hinge', 'vertical-push', 'vertical-pull', 'core'] }
  ],
  3: [
    { name: 'Full Body A', glyph: 'figureStrength', patterns: ['squat', 'horizontal-push', 'horizontal-pull', 'core'] },
    { name: 'Full Body B', glyph: 'figureStrength', patterns: ['hinge', 'vertical-push', 'vertical-pull', 'calves'] },
    { name: 'Full Body C', glyph: 'figureStrength', patterns: ['lunge', 'horizontal-push', 'vertical-pull', 'core'] }
  ],
  4: [
    { name: 'Upper A', glyph: 'arm', patterns: ['horizontal-push', 'horizontal-pull', 'vertical-push', 'biceps', 'triceps'] },
    { name: 'Lower A', glyph: 'legs', patterns: ['squat', 'hinge', 'calves', 'core'] },
    { name: 'Upper B', glyph: 'arm', patterns: ['vertical-push', 'vertical-pull', 'lateral-delt', 'posterior-shoulder', 'biceps'] },
    { name: 'Lower B', glyph: 'legs', patterns: ['hinge', 'lunge', 'calves', 'core'] }
  ],
  5: [
    { name: 'Push Day', glyph: 'barbell', patterns: ['horizontal-push', 'vertical-push', 'lateral-delt', 'triceps'] },
    { name: 'Pull Day', glyph: 'pullup', patterns: ['vertical-pull', 'horizontal-pull', 'posterior-shoulder', 'biceps'] },
    { name: 'Leg Day', glyph: 'legs', patterns: ['squat', 'hinge', 'lunge', 'calves'] },
    { name: 'Upper Day', glyph: 'arm', patterns: ['horizontal-push', 'horizontal-pull', 'lateral-delt', 'core'] },
    { name: 'Lower Day', glyph: 'legs', patterns: ['hinge', 'squat', 'calves', 'core'] }
  ],
  6: [
    { name: 'Push A', glyph: 'barbell', patterns: ['horizontal-push', 'vertical-push', 'lateral-delt', 'triceps'] },
    { name: 'Pull A', glyph: 'pullup', patterns: ['vertical-pull', 'horizontal-pull', 'posterior-shoulder', 'biceps'] },
    { name: 'Legs A', glyph: 'legs', patterns: ['squat', 'hinge', 'calves', 'core'] },
    { name: 'Push B', glyph: 'barbell', patterns: ['vertical-push', 'horizontal-push', 'triceps', 'lateral-delt'] },
    { name: 'Pull B', glyph: 'pullup', patterns: ['horizontal-pull', 'vertical-pull', 'biceps', 'posterior-shoulder'] },
    { name: 'Legs B', glyph: 'legs', patterns: ['hinge', 'lunge', 'calves', 'core'] }
  ]
}

/* Volume and rep ranges per goal. The progression policy is part of the prescription: a
 * strength plan that progresses by adding reps is not a strength plan. */
const PRESCRIPTION = {
  strength:  { compound: { sets: 5, reps: 5 },  accessory: { sets: 3, reps: 8 },  policy: 'greyskull' },
  muscle:    { compound: { sets: 4, reps: 8 },  accessory: { sets: 3, reps: 12 }, policy: 'double' },
  general:   { compound: { sets: 3, reps: 10 }, accessory: { sets: 3, reps: 12 }, policy: 'linear' },
  endurance: { compound: { sets: 3, reps: 15 }, accessory: { sets: 2, reps: 20 }, policy: 'linear' }
}

/* Roughly how long one exercise takes, including its rest. Compounds at strength rep ranges rest
 * longer, which is why the budget is per-goal rather than a flat number. */
const MINUTES_PER_EXERCISE = { strength: 12, muscle: 9, general: 8, endurance: 7 }

/** Which weekdays to train, spread out rather than stacked. 1 = Monday. */
export function scheduleFor(days) {
  const layout = {
    2: [1, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5],
    5: [1, 2, 3, 5, 6], 6: [1, 2, 3, 4, 5, 6]
  }
  return layout[clamp(days, 2, 6)] || layout[3]
}

/* ------------------------------------------------------------- generation ---- */

/**
 * Build a week of training from a brief.
 *
 * Returns routines in the app's own shape — the same objects the editor writes and the workout
 * screen reads — plus a week schedule and a list of plain-language notes explaining the choices.
 * Nothing here is a suggestion the app has to interpret later; it is a plan, ready to run.
 */
export function buildProgramme(input = {}) {
  const brief = normaliseBrief(input)
  const rx = PRESCRIPTION[brief.goal]
  const sessions = SPLITS[brief.daysPerWeek]
  const budget = Math.max(3, Math.floor(brief.sessionMinutes / MINUTES_PER_EXERCISE[brief.goal]))

  // Someone new does less, and does it on the compounds. Volume is the easiest thing to add
  // later and the hardest to recover from having too much of.
  const cap = brief.experience === 'new' ? Math.min(budget, 4) : budget

  const notes = []
  const missing = new Set()
  /* What each pattern has already been filled with, across the whole week.
   *
   * Without this, a four-day upper/lower split puts barbell deadlift 5×5 in both lower sessions,
   * because each one resolves the hinge slot independently and gets the same top-ranked answer.
   * Twice-weekly heavy deadlifts is a programming mistake a lifter spots instantly. Preferring a
   * different exercise for a pattern already used gives the second session a romanian deadlift,
   * which is what the split wanted. */
  const usedFor = new Map()
  const routines = sessions.map(session => {
    const wanted = [...session.patterns]
    // An emphasis adds a slot for that area rather than replacing a compound, so asking for
    // bigger arms never quietly costs you your squat.
    for (const muscle of brief.emphasis) {
      const extra = EMPHASIS_PATTERN[muscle]
      if (extra && !wanted.includes(extra)) wanted.push(extra)
    }

    const taken = []
    const ex = []
    for (const key of wanted) {
      if (ex.length >= cap) break
      // Variety applies to the heavy compounds only. Squatting and deadlifting the same way
      // twice a week is a programming mistake; curling the same way twice a week is just what
      // people do — and forcing an alternative there reaches past the good options into
      // "dumbbell biceps curl squat", which is not a biceps exercise.
      const alreadyUsed = PATTERNS[key]?.compound ? (usedFor.get(key) || []) : []
      const picked = resolvePattern(key, {
        equipment: brief.equipment, avoid: brief.avoid, taken: [...taken, ...alreadyUsed]
      }) || resolvePattern(key, { equipment: brief.equipment, avoid: brief.avoid, taken })
      if (!picked) { missing.add(PATTERNS[key]?.label || key); continue }
      taken.push(picked.id)
      usedFor.set(key, [...alreadyUsed, picked.id])
      const shape = PATTERNS[key].compound ? rx.compound : rx.accessory
      const cfg = { id: picked.id, sets: shape.sets, reps: shape.reps, weight: 0 }
      // A timed exercise cannot take a rep target; the plank in a core slot needs seconds.
      if (modeOf({ id: picked.id }) === 'time' || /plank|wall sit|dead hang|hollow hold/i.test(picked.n)) {
        cfg.mode = 'time'; cfg.sec = brief.goal === 'endurance' ? 60 : 40
        delete cfg.reps
      }
      ex.push(cfg)
    }

    /* Top up a session the equipment left thin.
     *
     * Bodyweight-only has no lateral raise and no curl, so a push/pull split leaves a two-exercise
     * pull day. Reporting that honestly is right; leaving the session at two is not. A second
     * variation of a pattern the session already covers is better training than a gap, and better
     * than reaching into a pattern the session was never about. */
    const MIN_PER_SESSION = 3
    if (ex.length < Math.min(MIN_PER_SESSION, cap)) {
      for (const key of wanted) {
        if (ex.length >= Math.min(MIN_PER_SESSION, cap)) break
        const extra = resolvePattern(key, { equipment: brief.equipment, avoid: brief.avoid, taken })
        if (!extra) continue
        taken.push(extra.id)
        const shape = PATTERNS[key].compound ? rx.compound : rx.accessory
        ex.push({ id: extra.id, sets: shape.sets, reps: shape.reps, weight: 0 })
      }
    }

    return { id: uid(), name: session.name, emoji: session.glyph, policy: rx.policy, ex }
  })

  const week = {}
  scheduleFor(brief.daysPerWeek).forEach((weekday, i) => { week[weekday] = routines[i % routines.length].id })

  notes.push(GOAL_NOTE[brief.goal])
  notes.push(`${brief.daysPerWeek} days a week, ${sessions.map(s => s.name).join(' · ')}.`)
  if (brief.experience === 'new') {
    notes.push('Kept short and compound-heavy to start — volume is easy to add later and hard to recover from having too much of.')
  }
  if (brief.emphasis.length) {
    notes.push(`Extra work for ${brief.emphasis.map(m => MUSCLE_NAME[m]).join(' and ')}, added on top rather than in place of the main lifts.`)
  }
  if (missing.size) {
    notes.push(`No ${[...missing].join(', ').toLowerCase()} in the plan — nothing in the library covers it with the equipment you listed.`)
  }
  if (brief.avoid.length) {
    notes.push(`Working around ${brief.avoid.map(id => EXIDX[id]?.n || id).join(', ')}.`)
  }

  return { brief, routines, week, notes }
}

const EMPHASIS_PATTERN = {
  chest: 'horizontal-push', 'upper-back': 'horizontal-pull', deltoids: 'lateral-delt',
  biceps: 'biceps', triceps: 'triceps', quadriceps: 'squat', hamstring: 'hinge',
  gluteal: 'hinge', calves: 'calves', abs: 'core'
}

const GOAL_NOTE = {
  strength: 'Built for strength: five sets of five on the main lifts, Greyskull progression, so the weight climbs whenever the last set says it can.',
  muscle: 'Built for size: eight to twelve reps, double progression — reps climb to the top of the range before the weight does.',
  general: 'Built for general fitness: moderate reps, linear progression, nothing that needs a spotter.',
  endurance: 'Built for endurance: higher reps, shorter rests, lighter loads that climb slowly.'
}

/* ----------------------------------------------------------------- review ---- */

/* What a coach — or a client without one — would notice reading a month of training.
 *
 * Every finding is derived from logged sets, never from self-report. "Feels hard" is not
 * evidence; four sessions in a row missing the rep target is. */

const DAY = 86400000

export function reviewTraining(S = {}, { days = 28, today = null } = {}) {
  const now = today ? new Date(today).getTime() : Date.now()
  const since = now - days * DAY
  const workouts = (S.workouts || []).filter(w => (w.start || Date.parse(w.d)) >= since)
  const findings = []

  /* --- turning up at all --- */
  const plannedPerWeek = Object.values(S.week || {}).filter(Boolean).length
  const expected = Math.round((plannedPerWeek * days) / 7)
  const done = workouts.filter(w => w.end).length
  if (expected > 0) {
    const ratio = done / expected
    if (ratio < 0.5) {
      findings.push({
        kind: 'attendance', severity: 'high',
        title: msg('{0} of {1} planned sessions', done, expected),
        detail: msg('Less than half the plan is being run. Before changing anything in the programme, the plan itself is probably asking for more days than the week has.'),
        suggest: 'reduce-days'
      })
    } else if (ratio < 0.8) {
      findings.push({
        kind: 'attendance', severity: 'medium',
        title: msg('{0} of {1} planned sessions', done, expected),
        detail: msg('Turning up most weeks but not all. Worth asking which session keeps getting dropped — that one is usually in the wrong place.'),
        suggest: null
      })
    }
  }
  const last = (S.workouts || []).at(-1)
  const idleDays = last ? Math.floor((now - (last.start || Date.parse(last.d))) / DAY) : null
  if (idleDays != null && idleDays >= 14) {
    findings.push({
      kind: 'lapsed', severity: 'high',
      title: msg('Nothing logged for {0} days', idleDays),
      detail: msg('Coming back after this long, the first week should be deliberately easy — the old working weights are not the right place to restart.'),
      suggest: 'restart-light'
    })
  }

  /* --- lifts that have stopped moving --- */
  for (const routine of S.routines || []) {
    for (const cfg of routine.ex || []) {
      const policy = policyFor(cfg, routine, modeOf(cfg))
      if (policy === 'off') continue
      const sessions = sessionsFor(S, cfg.id, cfg).filter(s => s.mode === modeOf(cfg))
      if (sessions.length < 3) continue
      const stalls = stallCount(sessions)
      const limit = DELOAD_AFTER[policy] || 3
      if (stalls >= limit) {
        findings.push({
          kind: 'stalled', severity: 'high',
          exerciseId: cfg.id, routineId: routine.id,
          title: msg('{0} has stalled', exArg(cfg.id)),
          detail: msg('{0} sessions in a row short of the target. The policy will deload it on its own; the question is whether the target was ever the right one.', stalls),
          suggest: 'deload'
        })
      } else if (stalls === limit - 1) {
        findings.push({
          kind: 'stalling', severity: 'medium',
          exerciseId: cfg.id, routineId: routine.id,
          title: msg('{0} is close to stalling', exArg(cfg.id)),
          detail: stalls === 1
            ? msg('{0} missed session. One more and it deloads.', stalls)
            : msg('{0} missed sessions. One more and it deloads.', stalls),
          suggest: null
        })
      }
    }
  }

  /* --- lifts with room to spare ---
   * Only from logged effort, and only when there is enough of it: three ratings is not a trend,
   * and guessing from volume alone would tell people to add weight because they did more sets. */
  if (effortOf(S) !== 'none') {
    const byExercise = new Map()
    for (const w of workouts) {
      for (const entry of w.entries || []) {
        const rated = (entry.sets || []).filter(s => s.done && (s.rir != null || s.rpe != null))
        if (!rated.length) continue
        const rir = rated.map(s => (s.rir != null ? s.rir : 10 - s.rpe))
        const cur = byExercise.get(entry.id) || []
        cur.push(Math.min(...rir))           // the hardest set of the session
        byExercise.set(entry.id, cur)
      }
    }
    for (const [exId, values] of byExercise) {
      if (values.length < 4) continue
      const avg = values.reduce((a, b) => a + b, 0) / values.length
      if (avg >= 4) {
        findings.push({
          kind: 'easy', severity: 'low',
          exerciseId: exId,
          title: msg('{0} is going up too slowly', exArg(exId)),
          detail: msg('Even the hardest set is averaging {0} reps in reserve across {1} sessions. The load is climbing slower than the person is.', avg.toFixed(1), values.length),
          suggest: 'bigger-jumps'
        })
      }
    }
  }

  /* --- what is not being trained --- */
  if (workouts.length >= 4) {
    const load = loadOfWorkouts(workouts)
    const untrained = Object.keys(MUSCLE_NAME).filter(m => !load[m])
    // Two or three gaps is a split, not a hole. A long list is a hole.
    if (untrained.length >= 4) {
      findings.push({
        kind: 'untrained', severity: 'medium',
        muscles: untrained,
        title: msg('{0} muscle groups untrained in {1} days', untrained.length, days),
        detail: untrained.length > 4
          ? msg('Nothing logged for {0} and others.', muscleList(untrained))
          : msg('Nothing logged for {0}.', muscleList(untrained)),
        suggest: 'add-accessory'
      })
    }
  }

  /* --- a plan nobody has touched --- */
  if ((S.routines || []).length && workouts.length >= 8) {
    const shapes = (S.routines || []).map(r => (r.ex || []).length)
    if (shapes.every(n => n > 0)) {
      findings.push({
        kind: 'stale', severity: 'low',
        title: msg('Same programme for {0} days', days),
        detail: msg('Nothing wrong with that while it is still working — worth a look only once something above says it is not.'),
        suggest: null
      })
    }
  }

  const order = { high: 0, medium: 1, low: 2 }
  findings.sort((a, b) => order[a.severity] - order[b.severity])
  return { days, sessions: done, expected, findings }
}

/* ------------------------------------------------------------ adaptation ---- */

/**
 * Turn the highest-priority finding into an actual change to a routine.
 *
 * Returns `{ routineId, before, after, changes, headline }` or null when nothing needs doing —
 * "your programme is fine" being a legitimate and under-used answer.
 *
 * The output is a routine in the app's own shape, so it drops straight into a coach's proposal
 * without any further interpretation.
 */
export function proposeAdaptation(S = {}, review = null, { unit = 'kg' } = {}) {
  const r = review || reviewTraining(S)
  const routines = S.routines || []
  if (!routines.length) return null

  const actionable = r.findings.find(f => f.suggest && f.routineId) ||
                     r.findings.find(f => f.suggest && f.exerciseId) ||
                     r.findings.find(f => f.suggest)
  if (!actionable) return null

  const routine = routines.find(x => x.id === actionable.routineId) ||
                  routines.find(x => (x.ex || []).some(e => e.id === actionable.exerciseId)) ||
                  routines[0]
  if (!routine) return null

  const before = JSON.parse(JSON.stringify(routine))
  const after = JSON.parse(JSON.stringify(routine))
  const changes = []

  if (actionable.suggest === 'deload') {
    const cfg = after.ex.find(e => e.id === actionable.exerciseId)
    if (cfg) {
      // Ten per cent off and rebuild. The weight itself lives in the log rather than the plan,
      // so what changes here is the rep target — one fewer, to make the same load land.
      const from = cfg.reps
      cfg.reps = Math.max(3, (cfg.reps || 5) - 1)
      changes.push({
        exerciseId: cfg.id, field: 'reps', from, to: cfg.reps,
        why: msg('Cut the rep target so the current load is reachable again, rather than deloading and climbing back through the same wall.')
      })
    }
  } else if (actionable.suggest === 'bigger-jumps') {
    const cfg = after.ex.find(e => e.id === actionable.exerciseId)
    if (cfg) {
      const from = cfg.sets
      cfg.sets = Math.min(6, (cfg.sets || 3) + 1)
      changes.push({
        exerciseId: cfg.id, field: 'sets', from, to: cfg.sets,
        why: msg('Added a set: the sessions are ending with too much left, and more work is the cheaper answer than a bigger weight jump.')
      })
    }
  } else if (actionable.suggest === 'reduce-days') {
    // Nothing about the routine changes — the plan has too many days in it. Say so rather than
    // silently editing exercises nobody is getting to.
    return {
      routineId: routine.id, before, after: before, changes: [],
      headline: msg('Fewer days, not different exercises'),
      note: msg('Only {0} of {1} planned sessions happened. Cutting the week down to what actually gets run beats redesigning sessions nobody reaches.', r.sessions, r.expected)
    }
  } else if (actionable.suggest === 'restart-light') {
    for (const cfg of after.ex) {
      const from = cfg.sets
      cfg.sets = Math.max(2, (cfg.sets || 3) - 1)
      if (cfg.sets !== from) {
        changes.push({ exerciseId: cfg.id, field: 'sets', from, to: cfg.sets, why: msg('One less set for the first week back.') })
      }
    }
  } else if (actionable.suggest === 'add-accessory') {
    const muscle = (actionable.muscles || [])[0]
    const key = EMPHASIS_PATTERN[muscle]
    const picked = key && resolvePattern(key, { taken: after.ex.map(e => e.id) })
    if (picked) {
      after.ex.push({ id: picked.id, sets: 3, reps: 12, weight: 0 })
      changes.push({
        exerciseId: picked.id, field: 'added', from: null, to: `${picked.n}`,
        why: msg('Nothing in the plan trains {0}.', muscleList([muscle], 1))
      })
    }
  }

  if (!changes.length) return null
  return {
    routineId: routine.id, before, after, changes,
    headline: actionable.title,
    note: actionable.detail
  }
}
