/* What happens with no model configured — which is the default, and has to be good enough that
 * the product is worth using anyway.
 *
 * Nothing here pretends to be clever. It reads the input for the things people reliably say and
 * writes the sentence a template can honestly write. Where a model would add nuance, this adds
 * nothing, and says nothing rather than guessing.
 */
import { EXIDX } from '@gymbuddy/domain'

const has = (text, ...words) => words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(text))

/**
 * Free text → a brief, by reading for the words people actually use.
 *
 * Every field falls back to the planner's own default when nothing in the text speaks to it, so
 * a vague sentence produces a sensible general plan rather than a confident wrong one.
 */
export function interpretBriefLocally(text = '', hint = {}) {
  const t = String(text || '')

  const goal =
    has(t, 'strong', 'stronger', 'strength', 'powerlift', 'heavier', '1rm', 'pr') ? 'strength'
    : has(t, 'muscle', 'size', 'bigger', 'hypertrophy', 'mass', 'bulk', 'aesthetic') ? 'muscle'
    : has(t, 'endurance', 'stamina', 'conditioning', 'cardio', 'marathon', 'fitter') ? 'endurance'
    : hint.goal || 'general'

  const experience =
    has(t, 'never', 'beginner', 'new', 'starting', 'start') ? 'new'
    : has(t, 'back', 'returning', 'again', 'used to', 'break', 'off') ? 'returning'
    : has(t, 'experienced', 'years', 'advanced', 'consistently', 'competed') ? 'experienced'
    : hint.experience || 'returning'

  const days = t.match(/(\d)\s*(?:days?|times?|x)\s*(?:a|per)?\s*week/i) ||
               t.match(/(?:^|\s)(\d)\s*(?:day|session)s?\b/i)
  const minutes = t.match(/(\d{2,3})\s*(?:min|minutes)/i) ||
                  (t.match(/(?:^|\s)(?:an?\s+)?hour/i) ? [null, '60'] : null)

  const EQUIPMENT_WORDS = {
    barbell: ['barbell', 'bar', 'rack', 'squat rack', 'olympic'],
    dumbbell: ['dumbbell', 'dumbell', 'db', 'free weights'],
    cable: ['cable', 'pulley'],
    'leverage machine': ['machine', 'machines', 'gym machine'],
    band: ['band', 'bands', 'resistance band'],
    kettlebell: ['kettlebell', 'kb'],
    'smith machine': ['smith'],
    'ez barbell': ['ez bar', 'ez barbell'],
    'body weight': ['bodyweight', 'body weight', 'calisthenics', 'no equipment', 'nothing']
  }
  const equipment = Object.entries(EQUIPMENT_WORDS)
    .filter(([, words]) => words.some(w => t.toLowerCase().includes(w)))
    .map(([key]) => key)
  // "full gym" or "commercial gym" means all of it, which is what people mean by it.
  if (has(t, 'gym', 'commercial gym', 'full gym') && !equipment.length) {
    equipment.push('barbell', 'dumbbell', 'cable', 'leverage machine')
  }

  const EMPHASIS_WORDS = {
    chest: ['chest', 'pecs'], 'upper-back': ['back', 'lats'], deltoids: ['shoulders', 'delts'],
    biceps: ['biceps', 'arms'], triceps: ['triceps'], quadriceps: ['quads', 'legs'],
    hamstring: ['hamstrings'], gluteal: ['glutes', 'butt'], calves: ['calves'], abs: ['abs', 'core']
  }
  const emphasis = Object.entries(EMPHASIS_WORDS)
    .filter(([, words]) => words.some(w => new RegExp(`\\b${w}\\b`, 'i').test(t)))
    .map(([key]) => key)
    .slice(0, 2)      // everything is not an emphasis

  const brief = {
    goal, experience,
    daysPerWeek: days ? Number(days[1]) : hint.daysPerWeek,
    sessionMinutes: minutes ? Number(minutes[1]) : hint.sessionMinutes,
    equipment: equipment.length ? equipment : hint.equipment,
    emphasis: emphasis.length ? emphasis : hint.emphasis
  }
  return { brief, summary: null }
}

/**
 * The note attached to a change, written from the change itself.
 *
 * Deliberately plain. The planner already worked out a `why` for every edit it made; the honest
 * fallback is to say those, joined up, rather than to dress them in a coaching voice a template
 * cannot actually produce.
 */
export function explainChangeLocally(change, { clientName = null } = {}) {
  if (!change) return { note: '' }
  const who = clientName ? `${clientName}: ` : ''
  const lines = (change.changes || []).map(c => {
    const ex = EXIDX[c.exerciseId]?.n || c.exerciseId
    if (c.field === 'added') return `Added ${c.to}. ${c.why}`
    return `${ex}: ${c.field} ${c.from} → ${c.to}. ${c.why}`
  })
  const body = lines.length ? lines.join(' ') : (change.note || '')
  return { note: `${who}${change.headline}. ${body}`.trim() }
}
