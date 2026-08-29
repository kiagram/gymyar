/* @gymyar/ai — the language layer, and the seam that makes it optional.
 *
 * What this does and does not do
 * -----------------------------
 * It does not decide anything numeric. Sets, reps, loads, progression steps and exercise
 * selection all belong to `@gymyar/domain`, which is tested and cannot hallucinate. This
 * package handles the two things a language model is genuinely better at than code:
 *
 *   interpretBrief  free text  →  a structured brief the planner accepts
 *   explainChange   a diff     →  the sentence a coach would have written
 *   parseLog        free text  →  logged sets
 *   describeForm    a photo    →  what is visible about the movement in it
 *
 * The first three have a deterministic implementation underneath. With no API key configured
 * the product still builds programmes, still reviews training and still parses "bench 5x5 at 80"
 * — it just phrases things from a template instead of writing prose. That is the difference
 * between a feature that degrades and a feature that goes down.
 *
 * `describeForm` is the exception, and it is worth being blunt about why. There is no template
 * that can look at a photograph, so this is the one thing here that does not degrade — with no
 * vision model configured it is simply absent, and `/api/ai/status` says so, so a screen can
 * hide the button rather than offer a feature that answers nothing.
 *
 * Every model output is validated by the domain before it can affect anything:
 * `normaliseBrief` throws away invented goals and equipment, and `parseLog` is the only thing
 * allowed to name an exercise. A model that returns nonsense costs a fallback, not a bad plan.
 * `describeForm` reaches nothing numeric at all: it returns sentences a person reads, next to a
 * photograph they can check them against, and it cannot change a single set.
 */
import { normaliseBrief, parseLog as parseLogLocal, say } from '@gymyar/domain'
import { anthropicProvider } from './anthropic.js'
import { openAICompatProvider, deepseekProvider, ollamaProvider, openaiProvider } from './openai-compat.js'
import { interpretBriefLocally, explainChangeLocally } from './fallback.js'

export { anthropicProvider, openAICompatProvider, deepseekProvider, ollamaProvider, openaiProvider }

/** No key, no network, no problem. Everything still works, in fewer words. */
export const nullProvider = { name: 'none', available: false, async complete() { return null } }

/* Model ids are configuration, not code — they change faster than this file will. These are
 * conservative defaults that work with an unconfigured key; set the env vars to the exact ids
 * you mean, and see .env.example for the pair this product is meant to run on. */
const DEEPSEEK_DEFAULT = 'deepseek-chat'
const ANTHROPIC_DEFAULT = 'claude-sonnet-4-5'
const OPENAI_FAST_DEFAULT = 'gpt-5-mini'
const OPENAI_DEEP_DEFAULT = 'gpt-5'

/**
 * What the environment asks for: a fast model, a better one, and whatever is on your own hardware.
 *
 * `local` is a failover rather than a preference — it answers when the hosted one is unreachable,
 * which covers an outage, a lapsed key and a route that stopped working, all of which look the
 * same from here. With nothing hosted configured it stops being a failover and becomes the model.
 */
export function providersFromEnv(env = process.env) {
  const ollama = (model, opts = {}) => model
    ? ollamaProvider({ baseUrl: env.OLLAMA_BASE_URL || undefined, model, ...opts })
    : null
  const localFast = ollama(env.OLLAMA_MODEL_FAST || env.OLLAMA_MODEL)
  const localDeep = ollama(env.OLLAMA_MODEL_DEEP || env.OLLAMA_MODEL_FAST || env.OLLAMA_MODEL)
  const vision = visionFromEnv(env, ollama)

  /* OpenAI is checked first because it is the one this deployment runs on. A second hosted key
   * in the same environment is a deliberate act — an operator moving between vendors — and the
   * one they are moving *to* is the one they just set, so first-wins with a documented order
   * beats a resolution rule nobody can predict from reading the file. */
  if (env.OPENAI_API_KEY) {
    const gpt = model => openaiProvider({
      apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL || undefined, model
    })
    return {
      fast: gpt(env.GYMYAR_MODEL_FAST || OPENAI_FAST_DEFAULT),
      // Falling back to the *deep* default rather than to the fast model, unlike the branches
      // below: naming only one model here means naming the cheap one, and quietly sending the
      // note a client reads to a mini model is the one substitution this split exists to stop.
      deep: gpt(env.GYMYAR_MODEL_DEEP || OPENAI_DEEP_DEFAULT),
      local: localFast,
      vision
    }
  }

  if (env.DEEPSEEK_API_KEY) {
    const ds = model => deepseekProvider({
      apiKey: env.DEEPSEEK_API_KEY, baseUrl: env.DEEPSEEK_BASE_URL || undefined, model
    })
    return {
      fast: ds(env.GYMYAR_MODEL_FAST || DEEPSEEK_DEFAULT),
      deep: ds(env.GYMYAR_MODEL_DEEP || env.GYMYAR_MODEL_FAST || DEEPSEEK_DEFAULT),
      local: localFast,
      vision
    }
  }

  if (env.ANTHROPIC_API_KEY) {
    const claude = model => anthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      model
    })
    const named = env.GYMYAR_AI_MODEL || ANTHROPIC_DEFAULT
    return {
      fast: claude(env.GYMYAR_MODEL_FAST || named),
      deep: claude(env.GYMYAR_MODEL_DEEP || named),
      local: localFast,
      vision
    }
  }

  if (localFast) return { fast: localFast, deep: localDeep, local: null, vision }
  return { fast: nullProvider, deep: nullProvider, local: null, vision }
}

/**
 * The model that may be shown a photograph — on this machine, or not at all.
 *
 * This is the one provider with no hosted branch, and that is a policy rather than an
 * oversight. The pictures this reads are somebody's body in a gym, taken so their coach could
 * look at a lift. Sending those to a vendor is a different act from sending them the sentence
 * "bench press stalled", it is not covered by anything the person agreed to when they uploaded
 * a form check, and an operator who set `OPENAI_API_KEY` for prose has not agreed to it either.
 * So the image path stops at `OLLAMA_BASE_URL`: the bytes stay on the hardware the deployment
 * already holds them on, and switching that off is deleting one variable.
 *
 * A shorter budget than the text tiers, because four short observations is the whole answer and
 * a vision model left to run writes an essay about the wallpaper.
 */
export function visionFromEnv(env = process.env, make = null) {
  const model = env.OLLAMA_MODEL_VISION
  if (!model) return null
  const build = make ||
    ((m, opts) => ollamaProvider({ baseUrl: env.OLLAMA_BASE_URL || undefined, model: m, ...opts }))
  return build(model, { maxTokens: 512 })
}

/** The primary model, for callers that only want to know whether there is one at all. */
export const providerFromEnv = (env = process.env) => providersFromEnv(env).fast

/* Which model answers which task.
 *
 * Two of the three jobs are cheap to get wrong: a brief is clamped by `normaliseBrief`, and a
 * rewritten log goes back through the parser, which is the only thing allowed to name an
 * exercise. Both are structured output nobody reads as prose, so the cheap model does them.
 *
 * The note attached to a proposed change is the one piece of model output a person reads
 * verbatim, in their own language, and judges the product by. That is what the better model is
 * for, and it is a few hundred tokens a time — the tier that costs more is the one used least.
 */
const TIER = { brief: 'fast', 'parse-log': 'fast', explain: 'deep' }

/**
 * Build the AI surface over one or more providers.
 *
 * Each method returns `{ ...result, source }` where source is 'model' or 'local', so the API can
 * tell a caller which one answered and the UI can be honest about it. Users forgive a template;
 * they do not forgive being told a template was intelligence.
 *
 * `provider` on its own still means "use this for everything", which is what the tests and any
 * single-model deployment want. `fast`/`deep` split it by task, and `local` is the failover.
 */
export function createAI({
  provider = null, fast = null, deep = null, local = null, vision = null, timeoutMs = 20000
} = {}) {
  const env = provider || fast || deep || local ? null : providersFromEnv()
  const tiers = {
    fast: fast || provider || env?.fast || nullProvider,
    deep: deep || provider || env?.deep || env?.fast || nullProvider
  }
  const localProvider = local || env?.local || null
  const anyAvailable = !!(tiers.fast.available || tiers.deep.available || localProvider?.available)

  /* Deliberately outside `tiers`, and deliberately not in the failover chain below. A text model
   * handed a task it cannot see the image for does not fail — it writes plausible observations
   * about a photograph it never received, which is the worst possible output of this feature.
   * There is no second-best answer here: either something can look at the picture, or nobody
   * can, and `describeForm` returns null. */
  const eyes = vision || env?.vision || null

  /* Three levels, in order: the model you pay for, the one on your own hardware, the template.
   * A hosted model that is unreachable — an outage, a lapsed key, a route that stopped working —
   * looks identical from here to one that answered badly, and both should cost the same thing. */
  const ask = async (task, fallback) => {
    const primary = tiers[TIER[task.kind] || 'fast']
    const chain = [primary, localProvider]
      .filter((p, i, all) => p?.available && all.indexOf(p) === i)
    let modelError = null

    for (const p of chain) {
      try {
        const result = await withTimeout(p.complete(task), p.timeoutMs ?? timeoutMs)
        if (result != null) return result
      } catch (e) {
        // A model being slow, rate-limited or down must never take a feature with it.
        modelError = e.message
      }
    }
    return { ...(await fallback()), source: 'local', ...(modelError ? { modelError } : {}) }
  }

  return {
    provider: tiers.fast.name,
    available: anyAvailable,
    /* Asked separately because it is a separate answer. Every other method works with no model
     * at all; this one does not exist without one, so a screen has to be able to ask. */
    vision: !!eyes?.available,
    // Named so an operator can see which model actually answers what, without reading the env.
    models: {
      fast: tiers.fast.available ? tiers.fast.model ?? tiers.fast.name : null,
      deep: tiers.deep.available ? tiers.deep.model ?? tiers.deep.name : null,
      local: localProvider?.available ? localProvider.model ?? localProvider.name : null,
      vision: eyes?.available ? eyes.model ?? eyes.name : null
    },

    /** Free text about goals and circumstances → a brief the planner will accept. */
    async interpretBrief(text, { hint = {}, lang = 'en' } = {}) {
      const result = await ask({
        kind: 'brief',
        system: inLanguage(BRIEF_SYSTEM, lang),
        input: String(text || '').slice(0, 2000),
        schema: BRIEF_SCHEMA
      }, async () => interpretBriefLocally(text, hint, lang))

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
    async explainChange(change, { clientName = null, tone = 'coach', lang = 'en', context = [] } = {}) {
      const result = await ask({
        kind: 'explain',
        system: inLanguage(EXPLAIN_SYSTEM, lang),
        // Rendered to English for the model: it is being asked to rewrite these reasons in the
        // target language, and an unrendered `{ msg, args }` object would tell it nothing.
        input: JSON.stringify({
          headline: say(change.headline),
          note: say(change.note),
          routine: change.after?.name,
          changes: (change.changes || []).map(c => ({
            exercise: c.exerciseId, field: c.field, from: c.from, to: c.to, why: say(c.why)
          })),
          /* The rest of what the review found, already worded by the domain. Sentences rather
           * than numbers on purpose: the arithmetic was done, and a model handed `-1.07` would
           * be deciding what that means about somebody's training. Here it is rewriting a
           * conclusion, which is the same job it does for everything else in this input. */
          context: (context || []).slice(0, 2).map(f => say(f.title)),
          clientName, tone
        }),
        schema: EXPLAIN_SCHEMA
      }, async () => explainChangeLocally(change, { clientName, lang }))

      const note = String(result.note ?? '').trim().slice(0, 600)
      // An empty or absurd answer is not better than the template it replaced.
      if (!note || note.length < 12) {
        return {
          ...await explainChangeLocally(change, { clientName, lang }), source: 'local',
          ...(result.modelError ? { modelError: result.modelError } : {})
        }
      }
      // modelError travels with a good answer too. The note above is the template's, and an
      // operator asking why the model never writes it is owed the reason on this path as much
      // as on the one where the answer was rejected outright.
      return {
        note, source: result.source ?? 'model',
        ...(result.modelError ? { modelError: result.modelError } : {})
      }
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
      if (!local.unresolved.length || !anyAvailable) return { ...local, source: 'local' }

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
    },

    /**
     * A photograph of somebody lifting → what is visible about the movement in it.
     *
     * `null` when nothing on this machine can see, which is not an error and is the answer a
     * caller should expect: there is no template that looks at a picture, so this is the one
     * method here with no deterministic floor under it. Check `vision` before offering it.
     *
     * `images` is `[{ mime, data }]`, base64, already read and already capped by whoever read
     * them — this package does no I/O and holds no opinion about how big a photograph may be.
     * `exercise` is a name out of the library, supplied by the caller, because a model naming
     * the lift itself would be a model naming a lift that does not exist.
     *
     * What comes back is prose next to a picture the reader is looking at, and it changes
     * nothing: there is no path from here to a set, a load or a programme.
     */
    async describeForm(images, { exercise = null, note = null, lang = 'en' } = {}) {
      if (!eyes?.available || !images?.length) return null

      let result
      try {
        result = await withTimeout(
          eyes.complete({
            kind: 'form',
            system: inLanguage(FORM_SYSTEM, lang),
            input: JSON.stringify({ exercise, asked: note }),
            schema: FORM_SCHEMA,
            images
          }),
          eyes.timeoutMs ?? timeoutMs
        )
      } catch (e) {
        // Same shape as an answer, so a caller renders "it could not look" rather than crashing.
        return { observations: [], unclear: true, source: 'model', modelError: e.message }
      }

      /* Four short sentences, and nothing longer than one. A vision model that starts narrating
       * is a vision model that has stopped looking, and the cap is what keeps the answer beside
       * the photograph rather than instead of it. */
      const observations = (Array.isArray(result?.observations) ? result.observations : [])
        .map(o => String(o ?? '').trim().slice(0, 240))
        .filter(Boolean)
        .slice(0, 4)

      return {
        observations,
        // A model that saw nothing useful says so, and an empty answer means the same thing.
        unclear: !observations.length || !!result?.unclear,
        source: 'model'
      }
    }
  }
}

/**
 * The same system prompt, told which language to answer in.
 *
 * Appended rather than baked into each prompt because only the output language changes — the
 * instructions themselves are the same job. English is left exactly as it was.
 *
 * This gets a model answering in Persian. It does not make the prompt *good* Persian coaching:
 * the register in EXPLAIN_SYSTEM ("slightly bored by the drama of it") is an English idea of a
 * coach, and a Persian one reads warmer and more formal. Rewriting that is a job for someone who
 * coaches in Persian, not a translation of what is here.
 */
const LANGUAGE_NAME = { fa: 'Persian (Farsi)' }
function inLanguage(system, lang) {
  const name = LANGUAGE_NAME[lang]
  return name ? `${system}

Write everything you output in ${name}.` : system
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
specific, and slightly bored by the drama of it.

You may also be given "context": other things the same review found, already decided and already
worded. Mention at most one, and only where it explains the change — somebody reading why their
rep target was cut is helped by "your weight has been coming off" and not by a list of everything
noticed this month. Where none of it bears on the change, leave all of it out. Do not turn it into
advice about eating, sleeping or anything outside the training in front of you.`

const FORM_SYSTEM = `You are looking at a photograph of somebody performing a strength exercise,
taken so that their coach can see the movement.

Describe only what is visible about the movement: where the bar is, what the back is doing, where
the knees, elbows, wrists and head are, whether anything is out of line for this point in the lift.

Do not describe the person. Their build, their weight, how lean or heavy they look, their
appearance and their clothing are not what this picture is for, and none of it belongs in the
answer. You are looking at a lift, not at a body.

Do not invent numbers. A photograph does not show you a weight, an angle in degrees, a rep count
or a percentage, and a number that cannot be measured from the picture is worse than silence.

One photograph is one instant of a lift. If it is blurred, badly framed, taken from an angle that
hides the movement, or does not show somebody lifting at all, set unclear and leave the
observations empty. Saying you cannot tell is a correct answer and a common one.

At most four observations, one short sentence each, addressed to the person lifting.`

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

const FORM_SCHEMA = {
  name: 'form_observations',
  description: 'What is visible about the movement in a form-check photograph',
  input_schema: {
    type: 'object',
    properties: {
      observations: { type: 'array', items: { type: 'string' } },
      unclear: { type: 'boolean' }
    },
    required: ['observations']
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
