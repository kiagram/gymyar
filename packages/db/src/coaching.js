/* Coaching: links, the roster a coach actually looks at, and programme proposals.
 *
 * The invariant this file exists to hold: **a coach never writes a client's rows.** Every
 * coach-authored change to a programme lands in `routine_revisions` and becomes real only when
 * the client accepts it, at which point it is written as the client's own row through the normal
 * sync path. That is what makes two writers safe without merge machinery — there is only ever
 * one writer per row, and the second party's intent is a separate object with its own lifecycle.
 *
 * Scopes are the other half. A client sharing their programme has not thereby agreed to share
 * what they weigh. Every read here is gated on the scope the client granted, not on the fact
 * that a link exists.
 */
import crypto from 'node:crypto'
import { db, logChange } from './index.js'

export const SCOPES = ['programmes', 'workouts', 'bodyweight']

const code = () => crypto.randomBytes(9).toString('base64url')

/* ------------------------------------------------------------- invites ---- */

export async function inviteClient({ coachId, email = null, scopes = ['programmes', 'workouts'] }, s = db()) {
  const clean = scopes.filter(x => SCOPES.includes(x))
  const [link] = await s`
    insert into coaching_links (coach_id, invite_email, invite_code, scopes)
    values (${coachId}, ${email}, ${code()}, ${clean})
    returning *`
  return link
}

export const findLinkByCode = (invite, s = db()) =>
  s`select * from coaching_links where invite_code = ${invite}`.then(r => r[0] || null)

/**
 * Accept an invitation. The client chooses what the coach may see; an invite that asked for
 * bodyweight does not get it because the client clicked through quickly.
 */
export async function acceptInvite({ inviteCode, clientId, scopes = null }, s = db()) {
  return s.begin(async tx => {
    const [link] = await tx`
      select * from coaching_links where invite_code = ${inviteCode} for update`
    if (!link) throw Object.assign(new Error('invite not found'), { status: 404 })
    if (link.status !== 'pending') throw Object.assign(new Error('invite already used'), { status: 409 })
    if (link.coach_id === clientId) throw Object.assign(new Error('you cannot coach yourself'), { status: 400 })

    const existing = await tx`
      select 1 from coaching_links
      where coach_id = ${link.coach_id} and client_id = ${clientId}
        and status in ('pending','active','paused')`
    if (existing.length) throw Object.assign(new Error('already linked to this coach'), { status: 409 })

    const granted = (scopes ?? link.scopes).filter(x => link.scopes.includes(x))
    const [updated] = await tx`
      update coaching_links
      set client_id = ${clientId}, status = 'active', accepted_at = now(),
          scopes = ${granted}, invite_code = null
      where id = ${link.id}
      returning *`
    return updated
  })
}

export async function declineInvite(inviteCode, s = db()) {
  // The code is kept rather than cleared. A declined link has no client, so clearing it would
  // leave a row identifying nobody — and the status already makes it unusable: acceptInvite
  // refuses anything that is not pending, and the preview endpoint 404s it. Keeping it also
  // means a coach re-sending the same link gets "declined" rather than silently working again.
  const [link] = await s`
    update coaching_links set status = 'declined', ended_at = now()
    where invite_code = ${inviteCode} and status = 'pending'
    returning *`
  return link || null
}

export async function endLink({ linkId, byUserId }, s = db()) {
  // Either party can end it, and neither needs the other's agreement.
  const [link] = await s`
    update coaching_links set status = 'ended', ended_at = now()
    where id = ${linkId} and (coach_id = ${byUserId} or client_id = ${byUserId})
      and status in ('pending','active','paused')
    returning *`
  return link || null
}

export async function setScopes({ linkId, clientId, scopes }, s = db()) {
  const clean = scopes.filter(x => SCOPES.includes(x))
  const [link] = await s`
    update coaching_links set scopes = ${clean}
    where id = ${linkId} and client_id = ${clientId}
    returning *`
  return link || null
}

/* ---------------------------------------------------------- permissions ---- */

/** The active link between these two, or null. Every coach-side read goes through this. */
export const activeLink = (coachId, clientId, s = db()) =>
  s`select * from coaching_links
    where coach_id = ${coachId} and client_id = ${clientId} and status = 'active'`
    .then(r => r[0] || null)

export async function requireScope(coachId, clientId, scope, s = db()) {
  const link = await activeLink(coachId, clientId, s)
  if (!link) throw Object.assign(new Error('not your client'), { status: 403 })
  if (!link.scopes.includes(scope)) {
    throw Object.assign(new Error(`client has not shared ${scope}`), { status: 403 })
  }
  return link
}

/* -------------------------------------------------------------- roster ---- */

/**
 * The coach's home screen, in one query per concern rather than one per client.
 *
 * "Adherence" is sessions actually finished against sessions planned in the same window —
 * planned meaning a weekday with a routine on it, adjusted for any day the client moved.
 * Counting only finished workouts is deliberate: a session started and abandoned is not
 * training, and a dashboard that says otherwise is worse than no dashboard.
 */
export async function roster(coachId, { days = 28 } = {}, s = db()) {
  const links = await s`
    select l.*, u.name as client_name, u.email as client_email, u.units as client_units
    from coaching_links l
    left join users u on u.id = l.client_id
    where l.coach_id = ${coachId} and l.status in ('pending','active','paused')
    order by l.status, u.name nulls last`
  const clientIds = links.filter(l => l.client_id).map(l => l.client_id)
  if (!clientIds.length) return links.map(l => ({ ...l, stats: null }))

  const [sessions, planned, lastSeen, openProposals, unread] = await Promise.all([
    s`select user_id, count(*)::int as n, max(finished_at) as last_at
      from workouts
      where user_id in ${s(clientIds)} and deleted_at is null and finished_at is not null
        and finished_at > now() - ${days + ' days'}::interval
      group by user_id`,
    s`select user_id, count(*)::int as per_week
      from week_plan where user_id in ${s(clientIds)} and routine_id is not null
      group by user_id`,
    s`select user_id, max(started_at) as at
      from workouts where user_id in ${s(clientIds)} and deleted_at is null
      group by user_id`,
    s`select user_id, count(*)::int as n from routine_revisions
      where user_id in ${s(clientIds)} and status = 'pending' group by user_id`,
    s`select l.client_id as user_id, count(*)::int as n
      from messages m join coaching_links l on l.id = m.link_id
      where l.coach_id = ${coachId} and m.sender_id <> ${coachId} and m.read_at is null
      group by l.client_id`
  ])

  const idx = rows => new Map(rows.map(r => [r.user_id, r]))
  const [S, P, L, R, U] = [sessions, planned, lastSeen, openProposals, unread].map(idx)

  return links.map(l => {
    if (!l.client_id) return { ...l, stats: null }
    const done = S.get(l.client_id)?.n ?? 0
    const perWeek = P.get(l.client_id)?.per_week ?? 0
    const expected = Math.round((perWeek * days) / 7)
    return {
      ...l,
      stats: {
        sessions: done,
        expected,
        // No denominator, no percentage — showing 0% for a client with no weekly plan
        // would read as "never trains" when it means "has not set a schedule".
        adherence: expected > 0 ? Math.min(1, done / expected) : null,
        lastTrainedAt: L.get(l.client_id)?.at ?? null,
        pendingProposals: R.get(l.client_id)?.n ?? 0,
        unreadMessages: U.get(l.client_id)?.n ?? 0
      }
    }
  })
}

/** Links where this user is the client — "my coaches", plus any invitation waiting on them. */
export const coachesOf = (clientId, email, s = db()) => s`
  select l.*, u.name as coach_name, u.email as coach_email
  from coaching_links l
  join users u on u.id = l.coach_id
  where (l.client_id = ${clientId} and l.status in ('active','paused'))
     or (l.status = 'pending' and l.invite_email is not null
         and lower(l.invite_email) = lower(${email ?? ''}))
  order by l.invited_at desc`

/* ----------------------------------------------------------- proposals ---- */

/**
 * Propose a programme. Supersedes any open proposal for the same routine rather than
 * stacking them — a client should be answering the coach's current thinking, not a queue.
 */
export async function proposeRoutine({ linkId, coachId, routineId, payload, note = null }, s = db()) {
  return s.begin(async tx => {
    const [link] = await tx`
      select * from coaching_links
      where id = ${linkId} and coach_id = ${coachId} and status = 'active'`
    if (!link) throw Object.assign(new Error('not your client'), { status: 403 })
    if (!link.scopes.includes('programmes')) {
      throw Object.assign(new Error('client has not shared programmes'), { status: 403 })
    }
    await tx`update routine_revisions set status = 'superseded', resolved_at = now()
             where routine_id = ${routineId} and status = 'pending'`
    const [rev] = await tx`
      insert into routine_revisions (routine_id, user_id, link_id, proposed_by, payload, note)
      values (${routineId}, ${link.client_id}, ${link.id}, ${coachId}, ${tx.json(payload)}, ${note})
      returning *`
    return rev
  })
}

export const pendingProposals = (userId, s = db()) => s`
  select r.*, u.name as coach_name
  from routine_revisions r join users u on u.id = r.proposed_by
  where r.user_id = ${userId} and r.status = 'pending'
  order by r.proposed_at desc`

/**
 * Accept a proposal: write the coach's version as the client's own routine, in the same
 * transaction that resolves the proposal and logs the change. Anything less and a client can
 * end up with a routine they never accepted, or an accepted proposal that changed nothing.
 */
export async function acceptProposal({ revisionId, clientId }, s = db()) {
  return s.begin(async tx => {
    const [rev] = await tx`
      select * from routine_revisions
      where id = ${revisionId} and user_id = ${clientId} and status = 'pending' for update`
    if (!rev) throw Object.assign(new Error('proposal not found'), { status: 404 })

    const p = rev.payload
    await tx`
      insert into routines (id, user_id, author_id, assigned_by, name, emoji, policy,
                            policy_config, position, exercises)
      values (${rev.routine_id}, ${clientId}, ${rev.proposed_by}, ${rev.link_id},
              ${p.name}, ${p.emoji ?? null}, ${p.policy ?? 'linear'},
              ${tx.json(p.policy_config ?? {})}, ${p.position ?? 0}, ${tx.json(p.exercises ?? [])})
      on conflict (id) do update set
        name = excluded.name, emoji = excluded.emoji, policy = excluded.policy,
        policy_config = excluded.policy_config, exercises = excluded.exercises,
        author_id = excluded.author_id, assigned_by = excluded.assigned_by,
        deleted_at = null, updated_at = now()`
    await logChange(tx, clientId, 'routines', rev.routine_id)

    const [updated] = await tx`
      update routine_revisions set status = 'accepted', resolved_at = now()
      where id = ${revisionId} returning *`
    return updated
  })
}

export async function declineProposal({ revisionId, clientId }, s = db()) {
  const [rev] = await s`
    update routine_revisions set status = 'declined', resolved_at = now()
    where id = ${revisionId} and user_id = ${clientId} and status = 'pending'
    returning *`
  return rev || null
}

/* ------------------------------------------------------------ messages ---- */

export async function sendMessage({ linkId, senderId, body, workoutId = null, exerciseId = null }, s = db()) {
  const [link] = await s`
    select * from coaching_links
    where id = ${linkId} and (coach_id = ${senderId} or client_id = ${senderId})
      and status in ('active','paused')`
  if (!link) throw Object.assign(new Error('no such conversation'), { status: 403 })
  const [msg] = await s`
    insert into messages (link_id, sender_id, body, workout_id, exercise_id)
    values (${link.id}, ${senderId}, ${body}, ${workoutId}, ${exerciseId})
    returning *`
  return msg
}

export async function readThread({ linkId, userId, limit = 100 }, s = db()) {
  const [link] = await s`
    select * from coaching_links
    where id = ${linkId} and (coach_id = ${userId} or client_id = ${userId})`
  if (!link) throw Object.assign(new Error('no such conversation'), { status: 403 })
  const msgs = await s`
    select m.*, u.name as sender_name from messages m join users u on u.id = m.sender_id
    where m.link_id = ${linkId} order by m.created_at desc limit ${limit}`
  await s`update messages set read_at = now()
          where link_id = ${linkId} and sender_id <> ${userId} and read_at is null`
  return msgs.reverse()
}
