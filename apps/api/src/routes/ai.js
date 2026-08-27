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
  buildProgramme, reviewTraining, proposeAdaptation, normaliseBrief, msg, EXIDX
} from '@gymyar/domain'
import { createAI } from '@gymyar/ai'
import { requireScope, activeLink } from '@gymyar/db/coaching.js'
import { db } from '@gymyar/db'
import { requireUser } from '../session.js'
import { stateForUser } from '../state.js'
import { limit } from '../rate-limit.js'

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
    const review = reviewTraining(S, { days })
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
    const review = reviewTraining(S, { days })
    const change = proposeAdaptation(S, review, { unit: S.unit })

    if (!change) {
      return {
        review, change: null, note: null, source: 'local',
        // Unrendered, like everything else the review returns — the coach's client renders it.
        headline: msg('Nothing to change'),
        detail: msg('Nothing in the last {0} days argues for a change. Leaving a programme alone while it is working is a decision too.', days)
      }
    }

    const [client] = await db()`select name, locale from users where id = ${clientId}`
    // The client's language, not the coach's — they are the one who reads this note.
    const explained = await ai.explainChange(change, {
      clientName: client?.name ?? null, lang: client?.locale
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
}
