/* Habits across the seam.
 *
 * Both tables are the client's, so almost everything here goes through `push` — the same path a
 * routine takes. What is coach-side is the proposal, which is 006's dispatch doing the job it
 * was built for: nothing above `APPLY` knows a habit from a programme.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import { createUser } from './users.js'
import { push, pullAll, pull } from './sync.js'
import {
  inviteClient, acceptInvite, propose, pendingProposals, acceptProposal, declineProposal,
  SCOPES, PROPOSAL_KINDS
} from './coaching.js'
import { db } from './index.js'

beforeAll(async () => { await setupDb() })
beforeEach(async () => { await truncateUsers() })
afterAll(async () => { await teardownDb() })

const linked = async (scopes = ['programmes', 'workouts', 'checkins', 'habits']) => {
  const coach = await createUser({ name: 'Coach', email: 'coach@x.test', isCoach: true })
  const client = await createUser({ name: 'Client', email: 'client@x.test' })
  const invite = await inviteClient({ coachId: coach.id, email: client.email, scopes })
  const link = await acceptInvite({ inviteCode: invite.invite_code, clientId: client.id })
  return { coach, client, link }
}

const walk = { id: 'hab1', title: 'Walk 10k', target_per_week: 7 }

describe('the scope', () => {
  it('is grantable, and asked for by default like check-ins', async () => {
    expect(SCOPES).toContain('habits')
    const coach = await createUser({ name: 'Coach', isCoach: true })
    const invite = await inviteClient({ coachId: coach.id })
    expect(invite.scopes).toContain('habits')
    expect(invite.scopes).not.toContain('photos')
  })
})

describe('a habit is the client\'s row', () => {
  it('is written through their own sync and comes back on a delta', async () => {
    const { client } = await linked()
    const before = await pullAll(client.id)
    await push(client.id, { habits: [walk] })

    const delta = await pull(client.id, before.cursor)
    expect(delta.changes.habits).toHaveLength(1)
    expect(delta.changes.habits[0]).toMatchObject({ title: 'Walk 10k', target_per_week: 7 })
    // Nobody assigned it, so the author is the person whose row it is.
    expect(delta.changes.habits[0].author_id).toBe(client.id)
  })

  it('cannot be written into somebody else\'s account', async () => {
    const { client } = await linked()
    const stranger = await createUser({ name: 'Nosy' })
    await push(client.id, { habits: [walk] })
    await expect(push(stranger.id, { habits: [{ ...walk, title: 'Mine now' }] }))
      .rejects.toMatchObject({ status: 409, code: 'not_yours' })
  })

  it('is archived without losing the ticks it already has', async () => {
    const { client } = await linked()
    await push(client.id, { habits: [walk] })
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17' }] })
    await push(client.id, { habits: [{ ...walk, archived_at: new Date() }] })

    const all = await pullAll(client.id)
    expect(all.changes.habits[0].archived_at).toBeTruthy()
    expect(all.changes.habitTicks).toHaveLength(1)
  })
})

describe('a tick', () => {
  it('is the row existing, and unticking is its tombstone', async () => {
    const { client } = await linked()
    await push(client.id, { habits: [walk] })
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17' }] })
    expect((await pullAll(client.id)).changes.habitTicks).toHaveLength(1)

    const mid = await pullAll(client.id)
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17', deleted: true }] })

    expect((await pullAll(client.id)).changes.habitTicks).toHaveLength(0)
    // A device that was away is told it was unticked, rather than never hearing about it.
    const delta = await pull(client.id, mid.cursor)
    expect(delta.changes.habitTicks[0].deleted_at).toBeTruthy()
  })

  it('can be re-ticked after being cleared', async () => {
    const { client } = await linked()
    await push(client.id, { habits: [walk] })
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17' }] })
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17', deleted: true }] })
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17' }] })
    expect((await pullAll(client.id)).changes.habitTicks).toHaveLength(1)
  })

  it('merges when two devices tick the same day', async () => {
    const { client } = await linked()
    await push(client.id, { habits: [walk] })
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17' }] })
    await push(client.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17' }] })
    expect((await pullAll(client.id)).changes.habitTicks).toHaveLength(1)
  })

  it('refuses to file itself under a habit that is not the pusher\'s', async () => {
    const { client } = await linked()
    const stranger = await createUser({ name: 'Nosy' })
    await push(client.id, { habits: [walk] })
    // The foreign key would happily accept this; the guarded insert is what does not.
    await expect(push(stranger.id, { habitTicks: [{ habit_id: 'hab1', on_date: '2026-08-17' }] }))
      .rejects.toMatchObject({ status: 409, code: 'not_yours' })
  })

  it('addresses a row by habit and day together, so two habits on one day both arrive', async () => {
    const { client } = await linked()
    const before = await pullAll(client.id)
    await push(client.id, { habits: [walk, { id: 'hab2', title: 'Water', target_per_week: 7 }] })
    await push(client.id, {
      habitTicks: [
        { habit_id: 'hab1', on_date: '2026-08-17' },
        { habit_id: 'hab2', on_date: '2026-08-17' }
      ]
    })
    const delta = await pull(client.id, before.cursor)
    expect(delta.changes.habitTicks).toHaveLength(2)
    expect(new Set(delta.changes.habitTicks.map(t => t.habit_id))).toEqual(new Set(['hab1', 'hab2']))
  })
})

describe('a habit a coach proposed', () => {
  it('is a kind the proposal table already knew about', () => {
    expect(PROPOSAL_KINDS.habit.scope).toBe('habits')
  })

  it('writes nothing until the client accepts, then is theirs', async () => {
    const { coach, client, link } = await linked()
    await propose({
      linkId: link.id, coachId: coach.id, kind: 'habit', subjectId: 'hab1',
      payload: { title: 'Walk 10k', target: 5 }
    })
    expect((await pullAll(client.id)).changes.habits).toHaveLength(0)

    const [open] = await pendingProposals(client.id)
    expect(open.kind).toBe('habit')
    await acceptProposal({ revisionId: open.id, clientId: client.id })

    const [h] = (await pullAll(client.id)).changes.habits
    expect(h).toMatchObject({ id: 'hab1', title: 'Walk 10k', target_per_week: 5 })
    expect(h.user_id).toBe(client.id)        // the row is the client's
    expect(h.author_id).toBe(coach.id)       // and it is recorded who suggested it
    expect(h.assigned_by).toBe(link.id)
  })

  it('is refused when habits were never shared', async () => {
    const { coach, client, link } = await linked(['programmes', 'workouts'])
    await expect(propose({
      linkId: link.id, coachId: coach.id, kind: 'habit', subjectId: 'hab1',
      payload: { title: 'Walk 10k' }
    })).rejects.toMatchObject({ status: 403 })
    expect(await pendingProposals(client.id)).toHaveLength(0)
  })

  it('can be declined, and leaves no habit behind', async () => {
    const { coach, client, link } = await linked()
    await propose({
      linkId: link.id, coachId: coach.id, kind: 'habit', subjectId: 'hab1',
      payload: { title: 'Walk 10k' }
    })
    const [open] = await pendingProposals(client.id)
    await declineProposal({ revisionId: open.id, clientId: client.id })
    expect((await pullAll(client.id)).changes.habits).toHaveLength(0)
  })

  it('clamps a target the coach wrote months ago rather than failing at the constraint', async () => {
    // The check constraint would have surfaced as an error under the client's accept button.
    const { coach, client, link } = await linked()
    await propose({
      linkId: link.id, coachId: coach.id, kind: 'habit', subjectId: 'hab1',
      payload: { title: 'Walk 10k', target: 9 }
    })
    const [open] = await pendingProposals(client.id)
    await acceptProposal({ revisionId: open.id, clientId: client.id })
    expect((await pullAll(client.id)).changes.habits[0].target_per_week).toBe(7)
  })

  it('refuses a payload with no title, rather than writing a nameless habit', async () => {
    const { coach, client, link } = await linked()
    await db()`
      insert into proposals (kind, subject_id, user_id, link_id, proposed_by, payload)
      values ('habit', 'hab1', ${client.id}, ${link.id}, ${coach.id}, ${db().json({ target: 3 })})`
    const [open] = await pendingProposals(client.id)
    await expect(acceptProposal({ revisionId: open.id, clientId: client.id }))
      .rejects.toMatchObject({ status: 422 })
    expect((await pullAll(client.id)).changes.habits).toHaveLength(0)
  })

  it('supersedes an earlier proposal for the same habit, not for a different one', async () => {
    const { coach, client, link } = await linked()
    const send = (subjectId, title) => propose({
      linkId: link.id, coachId: coach.id, kind: 'habit', subjectId, payload: { title }
    })
    await send('hab1', 'Walk 10k')
    await send('hab2', 'Water')
    await send('hab1', 'Walk 12k')

    const open = await pendingProposals(client.id)
    expect(open).toHaveLength(2)
    expect(open.find(p => p.subject_id === 'hab1').payload.title).toBe('Walk 12k')
  })
})
