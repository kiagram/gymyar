/* Check-ins and habits over HTTP.
 *
 * Both features live in one file because both sides of them are the same shape: a coach owns
 * some questions, a client owns every answer, and the answers do not travel through here at all.
 * A filled-in check-in and a ticked habit are rows in `push` — see `routes/sync.js` — which is
 * what lets them be written on a phone with no signal. What is left for HTTP is everything a
 * coach does, plus the one thing a client needs the server for: being told which questions they
 * are being asked this week.
 *
 * The gating follows `routes/coaching.js` exactly. `requireCoach(..., 'propose')` guards the two
 * writes that reach a client — saving a template that may already be scheduled on somebody, and
 * scheduling one. Removing is not gated: a lapsed coach taking their questions *off* a client
 * harms nobody, and a paywall that traps somebody's form on a stranger's screen would be worse
 * than no paywall. Reading is never gated, and **nothing a client does is gated at all.**
 */
import {
  saveTemplate, templatesOf, archiveTemplate,
  scheduleCheckin, unscheduleCheckin, scheduleFor, clientCheckins, formsFor
} from '@gymyar/db/checkins.js'
import { clientHabits } from '@gymyar/db/habits.js'
import { activeLink, linkById } from '@gymyar/db/coaching.js'
import { fieldsOf, BUILT_IN_FIELDS } from '@gymyar/domain'
import { requireUser } from '../session.js'
import { requireCoach } from '../entitlement.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

export default async function checkinRoutes(app) {
  /* ------------------------------------------------------- as a coach ---- */

  app.get('/api/coach/checkin-templates', async req => {
    const user = await requireUser(req)
    return { templates: await templatesOf(user.id) }
  })

  app.post('/api/coach/checkin-templates', async req => {
    const user = await requireUser(req)
    // Editing a template that is already on a client changes what they are asked next week, so
    // this is authorship reaching somebody else even though it writes only the coach's own row.
    await requireCoach(user.id, 'propose')
    const { id = null, title, fields } = req.body || {}
    if (!Array.isArray(fields)) throw bad('fields must be an array')
    return { template: await saveTemplate({ coachId: user.id, id, title, fields }) }
  })

  app.delete('/api/coach/checkin-templates/:id', async req => {
    const user = await requireUser(req)
    const template = await archiveTemplate({ coachId: user.id, id: req.params.id })
    if (!template) throw bad('template not found', 404)
    return { template }
  })

  app.get('/api/coach/clients/:id/checkins', async req => {
    const user = await requireUser(req)
    const rows = await clientCheckins({
      coachId: user.id, clientId: req.params.id, limit: req.query?.limit
    })
    // The questions travel with the answers. A row of values under keys nobody can read is not
    // a check-in, and the template it points at may since have been reworded or archived.
    return { checkins: rows.map(c => ({ ...c, fields: fieldsOf(c) })) }
  })

  app.get('/api/coach/clients/:id/checkin-schedule', async req => {
    const user = await requireUser(req)
    const link = await activeLink(user.id, req.params.id)
    if (!link) throw bad('not your client', 403)
    return { schedule: await scheduleFor(link.id) }
  })

  app.post('/api/coach/clients/:id/checkin-schedule', async req => {
    const user = await requireUser(req)
    await requireCoach(user.id, 'propose')
    const link = await activeLink(user.id, req.params.id)
    if (!link) throw bad('not your client', 403)
    const { templateId, weekday } = req.body || {}
    if (!templateId) throw bad('templateId is required')
    return {
      schedule: await scheduleCheckin({
        coachId: user.id, linkId: link.id, templateId, weekday
      })
    }
  })

  app.delete('/api/coach/clients/:id/checkin-schedule', async req => {
    const user = await requireUser(req)
    const link = await activeLink(user.id, req.params.id)
    if (!link) throw bad('not your client', 403)
    await unscheduleCheckin({ coachId: user.id, linkId: link.id })
    return { ok: true }
  })

  app.get('/api/coach/clients/:id/habits', async req => {
    const user = await requireUser(req)
    return clientHabits({ coachId: user.id, clientId: req.params.id, weeks: req.query?.weeks })
  })

  /* ------------------------------------------------------ as a client ---- */

  /**
   * Which questions this person is being asked, and by whom.
   *
   * The answers are not here and never will be — they are the client's rows and arrive through
   * sync. This is the one thing they cannot know offline: a coach's template lives on the
   * server, so the form has to be fetched before it can be filled in, and then it is theirs.
   *
   * Always at least one entry. Somebody with no coach answers the built-in set, which is not a
   * row anywhere — see `domain/src/checkin.js`. That is what makes a check-in a thing you can
   * keep for yourself rather than a feature that only switches on when somebody is watching.
   */
  app.get('/api/checkin', async req => {
    const user = await requireUser(req)

    return {
      // Built in `@gymyar/db/checkins.js`, because the review reads a person's answers against
      // the same fields this form asked them with.
      scheduled: await formsFor(user.id, user.email),
      // No title: a coach's is their own words and travels as written, but this one is a label
      // the app names in the reader's language. The server has no locale packs to name it with.
      builtIn: { templateId: null, title: null, fields: BUILT_IN_FIELDS }
    }
  })
}
