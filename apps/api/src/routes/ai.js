/* Programme drafting, training review and log parsing.
 *
 * The rule this file enforces at the HTTP boundary is the same one the rest of the product runs
 * on: **nothing here writes to anybody's training.** A drafted programme comes back for the
 * person to look at. A drafted change for a client comes back to the coach, who sends it as a
 * proposal the client then accepts. There is no endpoint that applies a plan to someone.
 *
 * That is not caution for its own sake — it is what makes the feature sellable to professionals.
 * A coach who can be overruled by software will not use the software.
 */
import {
  buildProgramme, reviewTraining, proposeAdaptation, normaliseBrief, msg, EXIDX,
  BUILT_IN_FIELDS, CHECKIN_SOURCES, fieldsOf
} from '@gymyar/domain'
import { createAI } from '@gymyar/ai'
import { requireScope, activeLink } from '@gymyar/db/coaching.js'
import { formsFor, scheduleFor } from '@gymyar/db/checkins.js'
import { byId } from '@gymyar/db/attachments.js'
import { db } from '@gymyar/db'
import { requireUser } from '../session.js'
import { stateForUser } from '../state.js'
import { limit } from '../rate-limit.js'
import { config } from '../config.js'
import { storage } from '../media.js'
import { mayRead } from './media.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

export default async function aiRoutes(app, opts = {}) {
  // Injectable so tests can drive a fake provider without a key or a network.
  const ai = opts.ai || createAI()

  app.get('/api/ai/status', async req => {
    await requireUser(req)
    // Said plainly, because the UI has to be able to tell the truth about which one answered.
    return {
      model: ai.available,
      provider: ai.provider,
      /* Asked and answered separately from `model`, because it is a different promise. Every
       * other feature here works with nothing configured; looking at a photograph does not, so
       * a screen needs to know whether to offer it at all rather than offering a button that
       * returns "no". */
      vision: ai.vision,
      // Which model answers which task, so "why does the wording keep changing" is answerable
      // without reading the deployment's environment.
      models: ai.models,
      note: ai.available
        ? 'Plans are built from your training data; the wording comes from a language model.'
        : 'No language model configured. Plans and reviews work exactly the same; the wording is written from a template.'
    }
  })

  /* ------------------------------------------------------- draft a plan ---- */

  /**
   * Turn a description, or a filled-in form, into a programme.
   *
   * Returns the routines and the week — it does not save them. The caller looks at what they got
   * and decides; a plan that installed itself would be a plan nobody read.
   */
  app.post('/api/ai/programme', { config: limit('model.draft') }, async req => {
    const user = await requireUser(req)
    const { text, brief: given } = req.body || {}

    let brief; let summary = null; let source = 'local'; let modelError = null
    if (text) {
      // The reader and the model both answer in the language this person set on their profile.
      const r = await ai.interpretBrief(String(text), { hint: given || {}, lang: user.locale })
      brief = r.brief; summary = r.summary; source = r.source; modelError = r.modelError ?? null
    } else {
      brief = normaliseBrief(given || {})
    }

    const programme = buildProgramme(brief)
    return {
      brief: programme.brief,
      summary,
      notes: programme.notes,
      week: programme.week,
      // Named here so the client can render a plan without the library loaded, and so a coach
      // reviewing one for somebody else sees lifts rather than ids.
      routines: programme.routines.map(r => ({
        ...r,
        ex: r.ex.map(e => ({ ...e, name: EXIDX[e.id]?.n || e.id }))
      })),
      source,
      ...(modelError ? { modelError } : {})
    }
  })

  /* ---------------------------------------------------------- review me ---- */

  /** What a coach would notice reading your last month. Findings only, no changes. */
  app.get('/api/ai/review', async req => {
    const user = await requireUser(req)
    const days = Math.min(180, Math.max(7, Number(req.query?.days) || 28))
    const S = await stateForUser(user.id)
    /* The questions this person was actually asked, so their answers can be read as the numbers
     * they are. A key nothing describes is skipped rather than guessed at — see `numericSeries`.
     * No `sources`: reading your own weigh-ins needs nobody's permission. */
    const forms = await formsFor(user.id, user.email)
    const review = reviewTraining(S, { days, fields: forms[0]?.fields ?? BUILT_IN_FIELDS })
    return { ...review, hasPlan: (S.routines || []).length > 0 }
  })

  /* ------------------------------------------------- review someone else ---- */

  /**
   * Draft a change to a client's programme.
   *
   * The output is exactly the payload the propose endpoint takes, so the coach's next step is to
   * read it, edit it and send it. Nothing reaches the client from here.
   */
  app.post('/api/coach/clients/:id/ai-review', { config: limit('model.draft') }, async req => {
    const user = await requireUser(req)
    const clientId = req.params.id
    // Reviewing training requires having been shown the training. Programmes alone are not
    // enough to say anything honest about whether something is working.
    await requireScope(user.id, clientId, 'workouts')
    const link = await activeLink(user.id, clientId)
    if (!link) throw bad('not your client', 403)

    const days = Math.min(180, Math.max(7, Number(req.body?.days) || 28))
    const S = await stateForUser(clientId)

    /* `stateForUser` reads a whole account, and the scope that got us here was `workouts`. What
     * a client said about their sleep, and what they weigh, are two further decisions they made
     * separately — so the review is told which of them it may read, and their granted scopes are
     * the list. A coach who was shown training and nothing else gets findings about training.
     *
     * Passing this rather than filtering `S`: a stripped state would also silently change what
     * the planner sees, and the next thing added to a review would arrive ungated by default. */
    const sources = link.scopes.filter(x => CHECKIN_SOURCES.includes(x))
    // The coach's own template — the only one they can be sure this client was asked by.
    const schedule = sources.includes('checkins') ? await scheduleFor(link.id) : null
    const fields = schedule && !schedule.archived_at ? fieldsOf(schedule) : BUILT_IN_FIELDS

    const review = reviewTraining(S, { days, fields, sources })
    const change = proposeAdaptation(S, review, { unit: S.unit })

    if (!change) {
      return {
        review, change: null, note: null, source: 'local',
        /* Everything, because nothing was acted on. "No change" is not the same sentence as
         * "nothing to see": a client whose weight is falling fast while their training is fine
         * produces no proposal at all, and a coach told only "nothing to change" would never
         * learn the one thing this review was any use for. */
        context: review.findings,
        // Unrendered, like everything else the review returns — the coach's client renders it.
        headline: msg('Nothing to change'),
        detail: msg('Nothing in the last {0} days argues for a change. Leaving a programme alone while it is working is a decision too.', days)
      }
    }

    /* Everything the review found that this change is not an answer to.
     *
     * A month usually turns up more than one thing, and `proposeAdaptation` acts on exactly one
     * of them — so a coach about to send "cut the rep target" is owed the finding that says the
     * lifts stalled while body weight came off. Sending that as its own field rather than
     * leaving the coach to work it out of `review.findings`: only the domain knows which
     * finding the change came from, and it says so in `from`.
     *
     * Ordered as the review ordered it, so the most severe is first and a screen can take the
     * top of the list without sorting it again.
     */
    const context = review.findings.filter(f => f !== change.from)

    const [client] = await db()`select name, locale from users where id = ${clientId}`
    // The client's language, not the coach's — they are the one who reads this note.
    const explained = await ai.explainChange(change, {
      clientName: client?.name ?? null,
      lang: client?.locale,
      /* Only what a person would raise while explaining a change. A low-severity "same
       * programme for 28 days" in the note a client reads is filler, and filler is what makes
       * somebody stop reading the ones that matter. */
      context: context.filter(f => f.severity !== 'low')
    })

    return {
      review,
      // Shaped as a proposal payload: the coach reviews it and posts it to the propose endpoint.
      change: {
        routineId: change.routineId,
        payload: {
          name: change.after.name,
          emoji: change.after.emoji ?? null,
          policy: change.after.policy ?? 'linear',
          exercises: change.after.ex
        },
        changes: change.changes.map(c => ({ ...c, name: EXIDX[c.exerciseId]?.n || c.exerciseId })),
        before: change.before.ex.map(e => ({ ...e, name: EXIDX[e.id]?.n || e.id }))
      },
      headline: change.headline,
      // Unrendered, like the review itself — the coach's client translates it.
      context,
      note: explained.note,
      source: explained.source,
      ...(explained.modelError ? { modelError: explained.modelError } : {})
    }
  })

  /* ----------------------------------------------------------- log by text ---- */

  /**
   * "bench 5x5 at 80" → sets, ready to save.
   *
   * Parsed and returned, never written. The caller shows what was understood and the person
   * confirms it — a log they did not read is a log they cannot trust.
   */
  app.post('/api/ai/parse-log', { config: limit('model.parse') }, async req => {
    const user = await requireUser(req)
    const text = String(req.body?.text || '')
    if (!text.trim()) throw bad('nothing to read')
    if (text.length > 2000) throw bad('too long to read in one go')

    const custom = await db()`
      select id, name from exercises where owner_id = ${user.id} and deleted_at is null`
    const result = await ai.parseLog(text, {
      custom: custom.map(c => ({ id: c.id, n: c.name, custom: true }))
    })

    return {
      entries: result.entries.map(e => ({ ...e, name: EXIDX[e.id]?.n || custom.find(c => c.id === e.id)?.name || e.id })),
      unresolved: result.unresolved,
      source: result.source
    }
  })

  /* --------------------------------------------------------- look at a lift ---- */

  /**
   * Show a form-check photograph to the model on this machine, and say what it saw.
   *
   * ## Why this subject and not the other one
   *
   * A `form_check` is a picture of a movement, filed against the workout and the exercise it
   * belongs to. A `progress` photo is a picture of a body, and it is refused here — not because
   * the plumbing could not carry it, but because the answer would be a machine's opinion of how
   * somebody looks, which is not a thing this product should be able to produce. There is no
   * flag to turn that on. If it is ever wanted it should be argued for on its own, by somebody
   * who has decided what a good answer would even be.
   *
   * ## What comes back, and what it can touch
   *
   * Sentences, next to a photograph the reader is already looking at, and nothing else. No set,
   * no load, no programme and no proposal is reachable from here — this is the same rule the
   * rest of the file runs on, and it is easier to keep because there is nothing structured in
   * the output to apply.
   *
   * The permission is `mayRead` from the media routes, unchanged: whoever may look at this
   * picture is who may be told what is in it.
   */
  app.post('/api/ai/form-check/:id', { config: limit('model.vision') }, async req => {
    const user = await requireUser(req)
    /* `expose`, because this is a 5xx raised on purpose — see the error handler in app.js, and
     * `routes/auth.js` for the other one. The generic "something went wrong" would be a lie: this
     * instance is working exactly as configured, and the caller is owed the real sentence. */
    if (!ai.vision) {
      throw Object.assign(
        new Error('this instance has no model that can look at a photograph'),
        { status: 501, expose: true }
      )
    }

    const row = await byId(req.params.id).catch(() => null)
    await mayRead(user, row)

    if (row.subject !== 'form_check') throw bad('only a form check can be looked at', 400)
    // Video is a form check too, and reading one means pulling frames out of it. Refused
    // plainly rather than silently answering about a container this cannot decode.
    if (row.kind !== 'photo') throw bad('only a photo can be looked at, not a video', 415)
    if (config.media.visionBytes && row.bytes > config.media.visionBytes) {
      throw bad(`too large to look at: the limit is ${config.media.visionBytes} bytes`, 413)
    }

    const bytes = await storage().get(row.storage_key)
    // A row whose object is missing is the sweeper's problem, not a 500 in somebody's face.
    if (!bytes) throw bad('no such attachment', 404)

    /* The lift is named here, from the library or from this person's own exercises, and handed
     * to the model as context. A model asked to identify the exercise itself would name one
     * that is not in the library, which is the same failure `parseLog` is built to prevent. */
    let name = EXIDX[row.exercise_id]?.n || null
    if (!name && row.exercise_id) {
      const [own] = await db()`
        select name from exercises where id = ${row.exercise_id} and owner_id = ${row.owner_id}`
        .catch(() => [])
      name = own?.name ?? null
    }

    const seen = await ai.describeForm(
      [{ mime: row.mime, data: bytes.toString('base64') }],
      { exercise: name, note: String(req.body?.note || '').slice(0, 300) || null, lang: user.locale }
    )

    return {
      attachmentId: row.id,
      exercise: name,
      observations: seen?.observations ?? [],
      unclear: seen?.unclear ?? true,
      ...(seen?.modelError ? { modelError: seen.modelError } : {})
    }
  })
}
