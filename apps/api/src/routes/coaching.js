/* Coach ↔ client. Every route here is a thin wrapper over packages/db/coaching.js, which is
 * where the permission rules live — deliberately, so they are enforced once and testable
 * without an HTTP server in the way.
 */
import {
  inviteClient, acceptInvite, declineInvite, endLink, setScopes, findLinkByCode,
  roster, coachesOf, requireScope, activeLink,
  proposeRoutine, pendingProposals, acceptProposal, declineProposal,
  sendMessage, readThread, SCOPES
} from '@gymbuddy/db/coaching.js'
import { pullAll } from '@gymbuddy/db/sync.js'
import { db } from '@gymbuddy/db'
import { requireUser } from '../session.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

export default async function coachingRoutes(app) {
  /* ------------------------------------------------------- as a coach ---- */

  app.get('/api/coach/clients', async req => {
    const user = await requireUser(req)
    const days = Math.min(365, Math.max(7, Number(req.query?.days) || 28))
    return { clients: await roster(user.id, { days }), windowDays: days }
  })

  app.post('/api/coach/invites', async req => {
    const user = await requireUser(req)
    const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : undefined
    const link = await inviteClient({ coachId: user.id, email, scopes })
    // The code is the invitation. Returned once, here, for the coach to pass on however they like.
    return { invite: { id: link.id, code: link.invite_code, email: link.invite_email, scopes: link.scopes } }
  })

  /** A client's training, as much of it as they have shared. */
  app.get('/api/coach/clients/:id', async req => {
    const user = await requireUser(req)
    const clientId = req.params.id
    const link = await requireScope(user.id, clientId, 'programmes')
    const { changes } = await pullAll(clientId)
    // The link row alone has no name on it — without this the screen is headed "Client".
    const [who] = await db()`select name, email, units from users where id = ${clientId}`

    const view = {
      link: { ...link, client_name: who?.name ?? null, client_email: who?.email ?? null },
      routines: changes.routines,
      settings: changes.settings
    }
    // Scope is checked per section rather than once at the door: a client who shared their
    // programme has not thereby agreed to hand over every weigh-in.
    if (link.scopes.includes('workouts')) view.workouts = changes.workouts
    if (link.scopes.includes('bodyweight')) view.bodyweight = changes.bodyweight
    view.weekPlan = changes.weekPlan
    view.proposals = await pendingProposals(clientId)
    return view
  })

  app.post('/api/coach/clients/:id/propose', async req => {
    const user = await requireUser(req)
    const { routineId, payload, note } = req.body || {}
    if (!routineId || !payload?.name) throw bad('routineId and a named payload are required')
    const link = await activeLink(user.id, req.params.id)
    if (!link) throw bad('not your client', 403)
    return { proposal: await proposeRoutine({ linkId: link.id, coachId: user.id, routineId, payload, note }) }
  })

  /* ------------------------------------------------------ as a client ---- */

  app.get('/api/coaches', async req => {
    const user = await requireUser(req)
    return {
      coaches: await coachesOf(user.id, user.email),
      proposals: await pendingProposals(user.id),
      scopes: SCOPES
    }
  })

  /** Look at an invitation before deciding — who is asking, and for what. */
  app.get('/api/invites/:code', async req => {
    const link = await findLinkByCode(req.params.code)
    if (!link || link.status !== 'pending') throw bad('invitation not found', 404)
    const [coach] = await db()`select name from users where id = ${link.coach_id}`
    return { invite: { coachName: coach?.name ?? 'A coach', scopes: link.scopes } }
  })

  app.post('/api/invites/:code/accept', async req => {
    const user = await requireUser(req)
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : null
    return { link: await acceptInvite({ inviteCode: req.params.code, clientId: user.id, scopes }) }
  })

  app.post('/api/invites/:code/decline', async req => {
    await requireUser(req)
    await declineInvite(req.params.code)
    return { ok: true }
  })

  app.post('/api/coaches/:linkId/scopes', async req => {
    const user = await requireUser(req)
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : []
    const link = await setScopes({ linkId: req.params.linkId, clientId: user.id, scopes })
    if (!link) throw bad('not your coach', 403)
    return { link }
  })

  app.post('/api/coaches/:linkId/end', async req => {
    const user = await requireUser(req)
    const link = await endLink({ linkId: req.params.linkId, byUserId: user.id })
    if (!link) throw bad('no such relationship', 404)
    return { ok: true }
  })

  /* ------------------------------------------------------- proposals ---- */

  app.get('/api/proposals', async req => {
    const user = await requireUser(req)
    return { proposals: await pendingProposals(user.id) }
  })

  app.post('/api/proposals/:id/accept', async req => {
    const user = await requireUser(req)
    return { proposal: await acceptProposal({ revisionId: req.params.id, clientId: user.id }) }
  })

  app.post('/api/proposals/:id/decline', async req => {
    const user = await requireUser(req)
    const rev = await declineProposal({ revisionId: req.params.id, clientId: user.id })
    if (!rev) throw bad('proposal not found', 404)
    return { proposal: rev }
  })

  /* -------------------------------------------------------- messages ---- */

  app.get('/api/threads/:linkId', async req => {
    const user = await requireUser(req)
    return { messages: await readThread({ linkId: req.params.linkId, userId: user.id }) }
  })

  app.post('/api/threads/:linkId', async req => {
    const user = await requireUser(req)
    const body = String(req.body?.body || '').trim()
    if (!body) throw bad('a message body is required')
    if (body.length > 4000) throw bad('message too long')
    return {
      message: await sendMessage({
        linkId: req.params.linkId, senderId: user.id, body,
        workoutId: req.body?.workoutId ?? null, exerciseId: req.body?.exerciseId ?? null
      })
    }
  })
}
