/* @gymbuddy/ai — the language layer, and the seam that makes it optional.
 *
 * What this does and does not do
 * -----------------------------
 * It does not decide anything numeric. Sets, reps, loads, progression steps and exercise
 * selection all belong to `@gymbuddy/domain`, which is tested and cannot hallucinate. This
 * package handles the two things a language model is genuinely better at than code:
 *
 *   interpretBrief  free text  →  a structured brief the planner accepts
 *   explainChange   a diff     →  the sentence a coach would have written
 *   parseLog        free text  →  logged sets
 *
 * Every one of them has a deterministic implementation underneath. With no API key configured
 * the product still builds programmes, still reviews training and still parses "bench 5x5 at 80"
 * — it just phrases things from a template instead of writing prose. That is the difference
 * between a feature that degrades and a feature that goes down.
 *
 * Every model output is validated by the domain before it can affect anything:
 * `normaliseBrief` throws away invented goals and equipment, and `parseLog` is the only thing
 * allowed to name an exercise. A model that returns nonsense costs a fallback, not a bad plan.
 */
import { normaliseBrief, parseLog as parseLogLocal } from '@gymbuddy/domain'
import { anthropicProvider } from './anthropic.js'
import { interpretBriefLocally, explainChangeLocally } from './fallback.js'

export { anthropicProvider }

/** No key, no network, no problem. Everything still works, in fewer words. */
export const nullProvider = { name: 'none', available: false, async complete() { return null } }

export function providerFromEnv(env = process.env) {
  const key = env.ANTHROPIC_API_KEY
  if (!key) return nullProvider
  return anthropicProvider({
    apiKey: key,
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    model: env.GYMBUDDY_AI_MODEL || 'claude-sonnet-4-5'
  })
}

/**
 * Build the AI surface over a provider.
 *
 * Each method returns `{ ...result, source }` where source is 'model' or 'local', so the API can
 * tell a caller which one answered and the UI can be honest about it. Users forgive a template;
 * they do not forgive being told a template was intelligence.
 */
export function createAI({ provider = providerFromEnv(), timeoutMs = 20000 } = {}) {
  const ask = async (task, fallback) => {
    if (!provider.available) return { ...(await fallback()), source: 'local' }
    try {
      const result = await withTimeout(provider.complete(task), timeoutMs)
      if (result == null) return { ...(await fallback()), source: 'local' }
      return result
    } catch (e) {
      // A model being slow, rate-limited or down must never take a feature with it.
      return { ...(await fallback()), source: 'local', modelError: e.message }
    }
  }

  return {
    provider: provider.name,
    available: !!provider.available,

    /** Free text about goals and circumstances → a brief the planner will accept. */
    async interpretBrief(text, { hint = {} } = {}) {
      const result = await ask({
        kind: 'brief',
        system: BRIEF_SYSTEM,
        input: String(text || '').slice(0, 2000),
        schema: BRIEF_SCHEMA
      }, async () => interpretBriefLocally(text, hint))

      // The model's answer goes through the same validation as a hand-filled form. An invented
      // goal or a made-up piece of equipment is dropped here, before it can reach the planner.
      const brief = normaliseBrief({ ...hint, ...(result.brief ?? result) })
      // modelError travels with the answer rather than being logged and forgotten: "it keeps
      // falling back" is a question an operator will ask, and this is the only thing that
      // answers it.
      return {
        brief, summary: result.summary ?? null,
        source: result.source ?? 'model',
        ...(result.modelError ? { modelError: result.modelError } : {})
      }
    },

    /** A proposed change → the sentence explaining it. */
    async explainChange(change, { clientName = null, tone = 'coach' } = {}) {
      const result = await ask({
        kind: 'explain',
        system: EXPLAIN_SYSTEM,
        input: JSON.stringify({
          headline: change.headline,
          note: change.note,
          routine: change.after?.name,
          changes: (change.changes || []).map(c => ({
            exercise: c.exerciseId, field: c.field, from: c.from, to: c.to, why: c.why
          })),
          clientName, tone
        }),
        schema: EXPLAIN_SCHEMA
      }, async () => explainChangeLocally(change, { clientName }))

      const note = String(result.note ?? '').trim().slice(0, 600)
      // An empty or absurd answer is not better than the template it replaced.
      if (!note || note.length < 12) {
        return {
          ...explainChangeLocally(change, { clientName }), source: 'local',
          ...(result.modelError ? { modelError: result.modelError } : {})
        }
      }
      return { note, source: result.source ?? 'model' }
    },

    /**
     * Free text → logged sets.
     *
     * The local parser runs first, always. It handles the shorthand people actually type, and
     * when it succeeds there is nothing for a model to add — asking one would cost latency and
     * money to arrive at the same answer, less reliably.
     */
    async parseLog(text, { custom = [], unit = 'kg' } = {}) {
      const local = parseLogLocal(text, { custom, unit })
      if (!local.unresolved.length || !provider.available) return { ...local, source: 'local' }

      const result = await ask({
        kind: 'parse-log',
        system: PARSE_SYSTEM,
        input: local.unresolved.map(u => u.line).join('\n').slice(0, 1000),
        schema: PARSE_SCHEMA
      }, async () => ({ lines: [] }))

      // The model rewrites messy phrasing into the shorthand the parser understands; the parser
      // still does the naming. That way a model can never put an exercise into somebody's log
      // that is not in the library.
      const rewritten = (result.lines || []).map(String).join('\n')
      const second = rewritten ? parseLogLocal(rewritten, { custom, unit }) : { entries: [], unresolved: [] }
      return {
        entries: [...local.entries, ...second.entries],
        unresolved: second.unresolved,
        unit,
        source: second.entries.length ? 'model' : 'local'
      }
    }
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`model timed out after ${ms}ms`)), ms).unref?.())
  ])
}

/* ---------------------------------------------------------------- prompts ---- */

const BRIEF_SYSTEM = `You read a person's description of their training situation and turn it into structured fields.

Extract only what they actually said. Do not infer a goal from enthusiasm, and do not fill in
equipment they did not mention — an empty list is a correct answer and the planner handles it.

goal: strength (wants to lift heavier) | muscle (wants to look bigger) | endurance (wants to last
longer) | general (fitness, health, "get in shape", or unclear)
experience: new (never trained, or a few weeks) | returning (trained before, coming back) |
experienced (trains consistently and knows the lifts)
daysPerWeek: 2 to 6
sessionMinutes: 20 to 120
equipment: any of body weight, dumbbell, barbell, cable, leverage machine, band, smith machine,
kettlebell, ez barbell, stability ball, medicine ball, assisted, sled machine, rope, trap bar
emphasis: muscle groups they specifically want more of, from chest, upper-back, deltoids, biceps,
triceps, quadriceps, hamstring, gluteal, calves, abs

Also write one sentence, addressed to them, saying what you understood. Plain language, no
jargon, no encouragement.`

const EXPLAIN_SYSTEM = `You are writing the note a strength coach attaches to a change in someone's
programme. You are given what changed and why, already decided — you are not deciding anything.

Write one short paragraph, at most three sentences, addressed to the person whose programme it is.
Say what is changing, and why in terms of what their own training showed. No greeting, no sign-off,
no exclamation marks, no encouragement, no emoji. Do not invent numbers that are not in the input.

Write like someone who trains people for a living and has said this a hundred times: direct,
specific, and slightly bored by the drama of it.`

const PARSE_SYSTEM = `You rewrite messy descriptions of completed sets into a strict shorthand.

Output one line per exercise, in exactly this form:
  <exercise name> <sets>x<reps> at <weight>
  <exercise name> <sets>x<seconds>s
  <exercise name> <minutes> min at <speed>

Add "rpe N" or "rir N" at the end of a line only if they said how hard it was.
Use the plain common name of the lift — "bench press", "squat", "romanian deadlift".
If a line does not describe completed sets, leave it out entirely. Do not guess at weights or
rep counts that were not stated. Returning nothing is correct when nothing was described.`

/* Schemas are enforced by the provider (as a tool definition) and again by the domain on the way
 * out. Belt and braces, because the second one is the one that actually protects a user. */

const BRIEF_SCHEMA = {
  name: 'training_brief',
  description: 'Structured training brief extracted from what the person said',
  input_schema: {
    type: 'object',
    properties: {
      goal: { type: 'string', enum: ['strength', 'muscle', 'endurance', 'general'] },
      experience: { type: 'string', enum: ['new', 'returning', 'experienced'] },
      daysPerWeek: { type: 'integer', minimum: 2, maximum: 6 },
      sessionMinutes: { type: 'integer', minimum: 20, maximum: 120 },
      equipment: { type: 'array', items: { type: 'string' } },
      emphasis: { type: 'array', items: { type: 'string' } },
      summary: { type: 'string' }
    },
    required: ['goal', 'daysPerWeek']
  }
}

const EXPLAIN_SCHEMA = {
  name: 'coaching_note',
  description: 'The note attached to a proposed programme change',
  input_schema: {
    type: 'object',
    properties: { note: { type: 'string' } },
    required: ['note']
  }
}

const PARSE_SCHEMA = {
  name: 'logged_sets',
  description: 'Completed sets rewritten as strict shorthand, one line per exercise',
  input_schema: {
    type: 'object',
    properties: { lines: { type: 'array', items: { type: 'string' } } },
    required: ['lines']
  }
}
