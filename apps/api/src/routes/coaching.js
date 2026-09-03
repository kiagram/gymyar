/* Coach ↔ client. Every route here is a thin wrapper over packages/db/coaching.js, which is
 * where the permission rules live — deliberately, so they are enforced once and testable
 * without an HTTP server in the way.
 *
 * There is a second kind of permission here now: whether the coach has paid. `requireCoach`
 * is that check, and it guards exactly three things — taking on a client, authoring a
 * proposal, and writing a message as the coach. Reading is never gated, and **nothing a
 * client does is ever gated**, which is why the guard appears only in the coach-side half of
 * this file. See apps/api/src/entitlement.js.
 */
import {
  inviteClient, acceptInvite, declineInvite, endLink, setScopes, findLinkByCode,
  roster, coachesOf, requireScope, activeLink, linkById,
  propose, pendingProposals, acceptProposal, declineProposal,
  sendMessage, readThread, SCOPES
} from '@gymyar/db/coaching.js'
import { weekStartsFor } from '@gymyar/domain'
import { notify, otherSide } from '../notify.js'
import { pullAll } from '@gymyar/db/sync.js'
import { forMessages } from '@gymyar/db/attachments.js'
import { db } from '@gymyar/db'
import { requireUser } from '../session.js'
import { requireCoach, requireCapacity, capacityFor } from '../entitlement.js'
import { billingEnabled } from '../payments/pricing.js'
import { withUrls } from '../media.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

/* Tell whoever wrote a proposal what became of it.
 *
 * The coach is `proposed_by`, which is on the row — so this needs no lookup and works for a
 * proposal authored months ago by a coach whose relationship has since been paused. What it
 * deliberately does not say is *which* routine: the answer is either "they took it" or "they
 * did not", and the coach opens the client to see anything more than that. */
const notifyAuthor = (proposal, event, clientName) =>
  notify(proposal.proposed_by, event, { from: clientName, kind: proposal.kind })


export default async function coachingRoutes(app) {
  /* ------------------------------------------------------- as a coach ---- */

  app.get('/api/coach/clients', async req => {
    const user = await requireUser(req)
    const days = Math.min(365, Math.max(7, Number(req.query?.days) || 28))
    // Capacity rides along with the roster because that is the screen it is about. A coach who
    // can see "23 of 25" coming is not one who finds out mid-invitation.
    const [clients, capacity] = await Promise.all([
      // The coach's own week, so "this week's habits" on this screen means the same days as the
      // grid their client is ticking. `users.locale` is the only place the server knows it from.
      roster(user.id, { days, weekStartsOn: weekStartsFor(user.locale) }),
      capacityFor(user.id)
    ])
    return { clients, windowDays: days, capacity }
  })

  app.post('/api/coach/invites', async req => {
    const user = await requireUser(req)
    // Also where a first-time coach's trial starts — this is the first coach action there is.
    await requireCoach(user.id, 'takeClients')
    // …and whether there is room for one more. Separate from the check above because they fail
    // for different reasons and want different screens: that one means the subscription has
    // lapsed, this one means it is too small, and only the second has an upgrade at the end of
    // it. `inviteClient` checks again under a lock — this is the half that can explain itself.
    await requireCapacity(user.id)
    const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes : undefined
    const link = await inviteClient({
      coachId: user.id, email, scopes, enforceCap: billingEnabled()
    })
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

  /**
   * Propose something to a client.
   *
   * `routineId` and a named payload is the shape this endpoint has always taken and still is —
   * every caller sends it, and a route that renamed its fields to look tidier next to `kind`
   * would break the app in the field to save a word here. A habit names `kind` and `subjectId`
   * instead; which fields a payload must carry is a question only the kind can answer, so the
   * check is per kind rather than one condition trying to describe both.
   */
  app.post('/api/coach/clients/:id/propose', async req => {
    const user = await requireUser(req)
    await requireCoach(user.id, 'propose')
    const { kind = 'routine', routineId, subjectId, payload, note } = req.body || {}
    const subject = kind === 'routine' ? routineId : subjectId
    if (!subject) throw bad(kind === 'routine' ? 'routineId is required' : 'subjectId is required')
    if (kind === 'routine' && !payload?.name) throw bad('a named payload is required')
    if (kind === 'habit' && !String(payload?.title ?? '').trim()) throw bad('a habit needs a title')

    const link = await activeLink(user.id, req.params.id)
    if (!link) throw bad('not your client', 403)
    const proposal = await propose({
      linkId: link.id, coachId: user.id, kind, subjectId: subject, payload, note
    })
    /* The subject is named in the notification because "a change to your programme" is a
     * sentence somebody can act on and "you have a proposal" is not. A habit's name is its
     * whole content; a routine's is what tells them which one moved. */
    await notify(link.client_id, 'proposal', {
      from: user.name, kind, subject: payload?.title || payload?.name || ''
    })
    return { proposal }
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
    // The cap belongs to the coach, and it is checked here because this is where their slot is
    // taken. What the client sees if it fails is a 409 that says their coach is full — never a
    // 402, and never anything that reads as a bill they are being handed.
    return {
      link: await acceptInvite({
        inviteCode: req.params.code, clientId: user.id, scopes, enforceCap: billingEnabled()
      })
    }
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
    const proposal = await acceptProposal({ revisionId: req.params.id, clientId: user.id })
    await notifyAuthor(proposal, 'accepted', user.name)
    return { proposal }
  })

  app.post('/api/proposals/:id/decline', async req => {
    const user = await requireUser(req)
    const rev = await declineProposal({ revisionId: req.params.id, clientId: user.id })
    if (!rev) throw bad('proposal not found', 404)
    await notifyAuthor(rev, 'declined', user.name)
    return { proposal: rev }
  })

  /* -------------------------------------------------------- messages ---- */

  app.get('/api/threads/:linkId', async req => {
    const user = await requireUser(req)
    const messages = await readThread({ linkId: req.params.linkId, userId: user.id })
    /* Attachments come back attached, in one query for the whole thread rather than one per
     * message. Their URLs are minted here because this is where the permission was checked —
     * `readThread` has just refused anybody who is not in this conversation. */
    const files = await forMessages(messages.map(m => m.id))
    return {
      messages: await Promise.all(messages.map(async m =>
        files.has(m.id) ? { ...m, attachments: await withUrls(files.get(m.id)) } : m))
    }
  })

  app.post('/api/threads/:linkId', async req => {
    const user = await requireUser(req)
    // Only the coach's side of the conversation is gated. A client writing to their coach is
    // never blocked — they are not the customer, and stranding them mid-question because
    // somebody else's card expired would be the worst possible moment to do it.
    const link = await linkById(req.params.linkId)
    if (link?.coach_id === user.id) await requireCoach(user.id, 'message')
    const body = String(req.body?.body || '').trim()
    if (!body) throw bad('a message body is required')
    if (body.length > 4000) throw bad('message too long')
    const message = await sendMessage({
      linkId: req.params.linkId, senderId: user.id, body,
      workoutId: req.body?.workoutId ?? null, exerciseId: req.body?.exerciseId ?? null
    })
    /* Awaited rather than fired and forgotten: an unawaited promise that rejects after the
     * response has gone out is an unhandled rejection with no request to blame it on. `notify`
     * cannot reject and cannot be slow enough to matter — it is one row and one HTTP call that
     * is allowed to fail. */
    const other = otherSide(link, user.id)
    if (other) await notify(other, 'message', { from: user.name })
    return {
      message
    }
  })
}
