/* What happens with no model configured — which is the default, and has to be good enough that
 * the product is worth using anyway.
 *
 * Nothing here pretends to be clever. It reads the input for the things people reliably say and
 * writes the sentence a template can honestly write. Where a model would add nuance, this adds
 * nothing, and says nothing rather than guessing.
 *
 * Language is a parameter, never module state. The client runs one language at a time, but the
 * API serves a Farsi lifter and an English one in the same second — a registered-global
 * translator would hand one of them the other's language.
 */
import { EXIDX, say, loadNames, namerFor } from '@gymbuddy/domain'
import { translatorFor } from './planner-strings.js'

/* Word boundaries are ASCII in JavaScript regex, so `\b` around a Persian word matches in the
 * wrong places or not at all. Latin terms keep the boundary check; everything else is a
 * substring test, which is what Persian's clitics and ZWNJ joins need anyway. */
const LATIN = /^[\x20-\x7F]+$/
const hit = (text, word) => LATIN.test(word)
  ? new RegExp(`\\b${word}\\b`, 'i').test(text)
  : text.includes(word)
const has = (text, ...words) => words.some(w => hit(text, w))

/* Equipment is matched loosely on purpose, the way it always was: people write "dumbbells",
 * "bands" and "machines", and a word boundary after the singular refuses every one of them.
 * These terms are distinctive enough that a substring cannot collide the way a goal word would. */
const hasLoose = (text, ...words) => {
  const lower = text.toLowerCase()
  return words.some(w => lower.includes(w.toLowerCase()))
}

/* Persian and Arabic-Indic digits, so "۳ روز" and "3 روز" read the same. */
const toLatinDigits = s => String(s)
  .replace(/[۰-۹]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x06F0 + 48))
  .replace(/[٠-٩]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x0660 + 48))

/**
 * What each language's reader looks for.
 *
 * Persian terms are deliberately specific rather than short. "بازو" alone means the upper arm and
 * sits inside both جلو بازو and پشت بازو, so matching it would tag every arm sentence as biceps.
 * This file's rule is that saying nothing beats guessing, and an ambiguous stem is a guess.
 */
const LEXICON = {
  en: {
    goal: {
      strength: ['strong', 'stronger', 'strength', 'powerlift', 'heavier', '1rm', 'pr'],
      muscle: ['muscle', 'size', 'bigger', 'hypertrophy', 'mass', 'bulk', 'aesthetic'],
      endurance: ['endurance', 'stamina', 'conditioning', 'cardio', 'marathon', 'fitter']
    },
    experience: {
      new: ['never', 'beginner', 'new', 'starting', 'start'],
      returning: ['back', 'returning', 'again', 'used to', 'break', 'off'],
      experienced: ['experienced', 'years', 'advanced', 'consistently', 'competed']
    },
    equipment: {
      barbell: ['barbell', 'bar', 'rack', 'squat rack', 'olympic'],
      dumbbell: ['dumbbell', 'dumbell', 'db', 'free weights'],
      cable: ['cable', 'pulley'],
      'leverage machine': ['machine', 'machines', 'gym machine'],
      band: ['band', 'bands', 'resistance band'],
      kettlebell: ['kettlebell', 'kb'],
      'smith machine': ['smith'],
      'ez barbell': ['ez bar', 'ez barbell'],
      'body weight': ['bodyweight', 'body weight', 'calisthenics', 'no equipment', 'nothing']
    },
    emphasis: {
      chest: ['chest', 'pecs'], 'upper-back': ['back', 'lats'], deltoids: ['shoulders', 'delts'],
      biceps: ['biceps', 'arms'], triceps: ['triceps'], quadriceps: ['quads', 'legs'],
      hamstring: ['hamstrings'], gluteal: ['glutes', 'butt'], calves: ['calves'], abs: ['abs', 'core']
    },
    gym: ['gym', 'commercial gym', 'full gym'],
    days: [/(\d)\s*(?:days?|times?|x)\s*(?:a|per)?\s*week/i, /(?:^|\s)(\d)\s*(?:day|session)s?\b/i],
    minutes: [/(\d{2,3})\s*(?:min|minutes)/i],
    hour: /(?:^|\s)(?:an?\s+)?hour/i,
    numberWords: {}
  },

  fa: {
    goal: {
      strength: ['قدرت', 'قوی', 'سنگین', 'رکورد', 'پاورلیفت', 'زور'],
      muscle: ['عضله', 'حجم', 'هایپرتروفی', 'بزرگ‌تر', 'بزرگتر', 'سایز', 'عضلانی'],
      endurance: ['استقامت', 'هوازی', 'کاردیو', 'نفس', 'ماراتن', 'آمادگی جسمانی']
    },
    experience: {
      new: ['مبتدی', 'تازه', 'تازه‌کار', 'هیچ‌وقت', 'هیچوقت', 'اولین بار'],
      returning: ['برگشت', 'دوباره', 'وقفه', 'قبلاً', 'قبلا'],
      experienced: ['حرفه‌ای', 'حرفه ای', 'پیشرفته', 'ساله', 'مداوم', 'مسابقه']
    },
    equipment: {
      barbell: ['هالتر', 'رک', 'میله'],
      dumbbell: ['دمبل'],
      cable: ['سیم‌کش', 'سیم کش', 'قرقره'],
      'leverage machine': ['دستگاه'],
      band: ['کش'],
      kettlebell: ['کتل‌بل', 'کتل بل'],
      'smith machine': ['اسمیت'],
      'ez barbell': ['ای‌زد', 'ای زد'],
      'body weight': ['وزن بدن', 'بدون وسیله', 'بدون تجهیزات', 'کالیستنیکس']
    },
    emphasis: {
      chest: ['سینه'], 'upper-back': ['زیربغل', 'لت'], deltoids: ['سرشانه', 'دلتوئید'],
      biceps: ['جلو بازو'], triceps: ['پشت بازو'], quadriceps: ['چهارسر', 'جلو پا', 'ران'],
      hamstring: ['همسترینگ', 'پشت پا'], gluteal: ['باسن', 'سرینی'],
      calves: ['ساق'], abs: ['شکم', 'سیکس‌پک', 'سیکس پک']
    },
    gym: ['باشگاه', 'بدنسازی'],
    days: [/(\d)\s*(?:روز|بار|جلسه)/, /هفته‌?ای\s*(\d)/],
    minutes: [/(\d{2,3})\s*دقیقه/],
    hour: /(?:یک\s*)?ساعت/,
    // Written-out counts: "سه روز در هفته" is at least as common as "۳ روز در هفته".
    numberWords: { 'دو': 2, 'سه': 3, 'چهار': 4, 'پنج': 5, 'شش': 6 }
  }
}

const lexiconFor = lang => LEXICON[lang] || LEXICON.en

/** First key in `table` whose terms appear in the text, or null. */
const firstMatch = (text, table) =>
  Object.keys(table).find(key => has(text, ...table[key])) || null

/** Every key in `table` whose terms appear — order follows the table, not the sentence. */
const allMatches = (text, table, match = has) =>
  Object.keys(table).filter(key => match(text, ...table[key]))

function readDays(text, lex) {
  for (const re of lex.days) {
    const m = text.match(re)
    if (m) return Number(m[1])
  }
  // "سه روز در هفته" — a written-out count directly before the unit.
  for (const [word, n] of Object.entries(lex.numberWords)) {
    if (new RegExp(`${word}\\s*(?:روز|بار|جلسه)`).test(text)) return n
  }
  return null
}

function readMinutes(text, lex) {
  for (const re of lex.minutes) {
    const m = text.match(re)
    if (m) return Number(m[1])
  }
  return lex.hour.test(text) ? 60 : null
}

/**
 * Free text → a brief, by reading for the words people actually use.
 *
 * Every field falls back to the planner's own default when nothing in the text speaks to it, so
 * a vague sentence produces a sensible general plan rather than a confident wrong one.
 */
export function interpretBriefLocally(text = '', hint = {}, lang = 'en') {
  const lex = lexiconFor(lang)
  const raw = String(text || '')
  // Digits normalise for the number patterns; the term tables read the original, because
  // normalising Persian letters is not this function's business.
  const t = toLatinDigits(raw)

  const goal = firstMatch(t, lex.goal) || hint.goal || 'general'
  const experience = firstMatch(t, lex.experience) || hint.experience || 'returning'

  const equipment = allMatches(t, lex.equipment, hasLoose)
  // "full gym" or "باشگاه" means all of it, which is what people mean by it.
  if (!equipment.length && hasLoose(t, ...lex.gym)) {
    equipment.push('barbell', 'dumbbell', 'cable', 'leverage machine')
  }

  const emphasis = allMatches(t, lex.emphasis).slice(0, 2)   // everything is not an emphasis

  const days = readDays(t, lex)
  const minutes = readMinutes(t, lex)

  const brief = {
    goal, experience,
    daysPerWeek: days ?? hint.daysPerWeek,
    sessionMinutes: minutes ?? hint.sessionMinutes,
    equipment: equipment.length ? equipment : hint.equipment,
    emphasis: emphasis.length ? emphasis : hint.emphasis
  }
  return { brief, summary: null }
}

/* The sentence shapes the note is assembled from, per language. `field` names are the domain's
 * own column words, so they are translated here rather than passed through. */
const NOTE = {
  en: {
    added: (what, why) => `Added ${what}. ${why}`,
    changed: (ex, field, from, to, why) => `${ex}: ${field} ${from} → ${to}. ${why}`,
    field: f => f,
    join: ' ',
    lead: (who, headline) => `${who}${headline}. `
  },
  fa: {
    added: (what, why) => `${what} اضافه شد. ${why}`,
    changed: (ex, field, from, to, why) => `${ex}: ${field} از ${from} به ${to}. ${why}`,
    field: f => ({ reps: 'تکرار', sets: 'ست', weight: 'وزنه', seconds: 'ثانیه' }[f] || f),
    join: ' ',
    lead: (who, headline) => `${who}${headline}. `
  }
}

/**
 * The note attached to a change, written from the change itself.
 *
 * Deliberately plain. The planner already worked out a `why` for every edit it made; the honest
 * fallback is to say those, joined up, rather than to dress them in a coaching voice a template
 * cannot actually produce.
 *
 * Async for one reason: the exercise names are a pack that is loaded, not a table that is
 * imported. A note is the one thing a client reads verbatim, and a Persian sentence that names
 * the lift in English is a note that was translated by somebody who did not read it.
 */
export async function explainChangeLocally(change, { clientName = null, lang = 'en' } = {}) {
  if (!change) return { note: '' }
  const shape = NOTE[lang] || NOTE.en
  // The planner hands back sentences it has not rendered, so the language is decided here —
  // at the moment the note is written, in the language of whoever will read it.
  const t = translatorFor(lang)
  // The same pack the client renders screens from, reached through the domain. Null for a
  // language without one, which `namerFor` turns back into the English name per exercise.
  const exName = namerFor(await loadNames(lang))
  const render = m => say(m, { t, exName })
  const who = clientName ? `${clientName}: ` : ''
  const lines = (change.changes || []).map(c => {
    const ex = exName(EXIDX[c.exerciseId]) || c.exerciseId
    return c.field === 'added'
      ? shape.added(c.to, render(c.why))
      : shape.changed(ex, shape.field(c.field), c.from, c.to, render(c.why))
  })
  const body = lines.length ? lines.join(shape.join) : render(change.note)
  return { note: `${shape.lead(who, render(change.headline))}${body}`.trim() }
}
