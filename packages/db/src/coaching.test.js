import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import { createUser } from './users.js'
import { push, pullAll } from './sync.js'
import {
  inviteClient, acceptInvite, declineInvite, endLink, setScopes, activeLink, requireScope,
  roster, coachesOf, proposeRoutine, pendingProposals, acceptProposal, declineProposal,
  sendMessage, readThread
} from './coaching.js'

// Wrapped, not passed directly: a hook that returns a function is treated by Vitest as a
// teardown callback, and setupDb returns the postgres handle — which is itself callable.
// Vitest would then invoke it with no arguments at the end of the file, and postgres.js
// would throw NOT_TAGGED_CALL long after every assertion had already passed.
beforeAll(async () => { await setupDb() })
beforeEach(async () => { await truncateUsers() })
afterAll(async () => { await teardownDb() })

const pair = async (scopes) => {
  const coach = await createUser({ name: 'Coach', email: 'coach@x.test', isCoach: true })
  const client = await createUser({ name: 'Client', email: 'client@x.test' })
  const invite = await inviteClient({ coachId: coach.id, email: client.email, scopes })
  return { coach, client, invite }
}
const linked = async (scopes = ['programmes', 'workouts']) => {
  const { coach, client, invite } = await pair(scopes)
  const link = await acceptInvite({ inviteCode: invite.invite_code, clientId: client.id })
  return { coach, client, link }
}
const plan = { name: 'Push A', emoji: '💪', policy: 'linear', exercises: [{ id: '0025', sets: 5, reps: 5 }] }

describe('invitations', () => {
  it('links a coach to a client on accept', async () => {
    const { coach, client, link } = await linked()
    expect(link.status).toBe('active')
    expect(await activeLink(coach.id, client.id)).toBeTruthy()
  })

  it('burns the invite code once used', async () => {
    const { client, invite } = await pair()
    await acceptInvite({ inviteCode: invite.invite_code, clientId: client.id })
    const other = await createUser({ name: 'Someone else' })
    // 404, not 409: accepting clears the code entirely, so a leaked invite link cannot even
    // confirm that a relationship exists — it looks the same as one that never did.
    await expect(acceptInvite({ inviteCode: invite.invite_code, clientId: other.id }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('refuses to let a coach coach themselves', async () => {
    const coach = await createUser({ name: 'Coach', isCoach: true })
    const invite = await inviteClient({ coachId: coach.id, email: 'coach@x.test' })
    await expect(acceptInvite({ inviteCode: invite.invite_code, clientId: coach.id }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('refuses a second live link between the same pair', async () => {
    const { coach, client } = await linked()
    const again = await inviteClient({ coachId: coach.id, email: client.email })
    await expect(acceptInvite({ inviteCode: again.invite_code, clientId: client.id }))
      .rejects.toMatchObject({ status: 409 })
  })

  it('lets the client decline without ever linking', async () => {
    const { coach, client, invite } = await pair()
    await declineInvite(invite.invite_code)
    expect(await activeLink(coach.id, client.id)).toBeNull()
  })

  it('shows a pending invitation to the client it was addressed to', async () => {
    const { client } = await pair()
    const rows = await coachesOf(client.id, client.email)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
  })

  it('lets either side end the relationship alone', async () => {
    const { coach, client, link } = await linked()
    expect(await endLink({ linkId: link.id, byUserId: client.id })).toBeTruthy()
    expect(await activeLink(coach.id, client.id)).toBeNull()
  })
})

describe('scopes', () => {
  it('grants only what the invite asked for', async () => {
    const { coach, client, invite } = await pair(['programmes', 'workouts'])
    const link = await acceptInvite({
      inviteCode: invite.invite_code, clientId: client.id, scopes: ['programmes']
    })
    expect(link.scopes).toEqual(['programmes'])
    await expect(requireScope(coach.id, client.id, 'workouts')).rejects.toMatchObject({ status: 403 })
    await expect(requireScope(coach.id, client.id, 'programmes')).resolves.toBeTruthy()
  })

  it('cannot be widened by the client past what was asked', async () => {
    const { client, invite } = await pair(['programmes'])
    const link = await acceptInvite({
      inviteCode: invite.invite_code, clientId: client.id, scopes: ['programmes', 'bodyweight']
    })
    expect(link.scopes).toEqual(['programmes'])
  })

  it('sharing a programme does not share what you weigh', async () => {
    const { coach, client } = await linked(['programmes', 'workouts'])
    await expect(requireScope(coach.id, client.id, 'bodyweight')).rejects.toMatchObject({ status: 403 })
  })

  it('lets a client revoke a scope later', async () => {
    const { coach, client, link } = await linked(['programmes', 'workouts'])
    await setScopes({ linkId: link.id, clientId: client.id, scopes: ['programmes'] })
    await expect(requireScope(coach.id, client.id, 'workouts')).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a stranger outright', async () => {
    const stranger = await createUser({ name: 'Nosy' })
    const { client } = await linked()
    await expect(requireScope(stranger.id, client.id, 'workouts')).rejects.toMatchObject({ status: 403 })
  })
})

describe('proposals', () => {
  it('never writes the client\'s routine until they accept', async () => {
    const { coach, client, link } = await linked()
    await proposeRoutine({ linkId: link.id, coachId: coach.id, routineId: 'r1', payload: plan })
    expect((await pullAll(client.id)).changes.routines).toHaveLength(0)

    const [open] = await pendingProposals(client.id)
    await acceptProposal({ revisionId: open.id, clientId: client.id })
    const routines = (await pullAll(client.id)).changes.routines
    expect(routines).toHaveLength(1)
    expect(routines[0].name).toBe('Push A')
    expect(routines[0].author_id).toBe(coach.id)
  })

  it('cannot erase an edit the client made themselves', async () => {
    // the exact failure openGym's whole-state sync had: two writers, one loses silently
    const { coach, client, link } = await linked()
    await push(client.id, { routines: [{ id: 'r1', name: 'My own tweak', exercises: [{ id: '0043' }] }] })
    await proposeRoutine({ linkId: link.id, coachId: coach.id, routineId: 'r1', payload: plan })

    const still = (await pullAll(client.id)).changes.routines[0]
    expect(still.name).toBe('My own tweak')     // untouched while the proposal is open

    const [open] = await pendingProposals(client.id)
    await declineProposal({ revisionId: open.id, clientId: client.id })
    const after = (await pullAll(client.id)).changes.routines[0]
    expect(after.name).toBe('My own tweak')     // and untouched after declining
  })

  it('shows up in the client\'s next sync once accepted', async () => {
    const { coach, client, link } = await linked()
    const before = await pullAll(client.id)
    await proposeRoutine({ linkId: link.id, coachId: coach.id, routineId: 'r1', payload: plan })
    const [open] = await pendingProposals(client.id)
    await acceptProposal({ revisionId: open.id, clientId: client.id })
    const { pull } = await import('./sync.js')
    const delta = await pull(client.id, before.cursor)
    expect(delta.changes.routines?.[0]?.name).toBe('Push A')
  })

  it('supersedes an older proposal instead of stacking them', async () => {
    const { coach, client, link } = await linked()
    await proposeRoutine({ linkId: link.id, coachId: coach.id, routineId: 'r1', payload: plan })
    await proposeRoutine({
      linkId: link.id, coachId: coach.id, routineId: 'r1', payload: { ...plan, name: 'Push B' }
    })
    const open = await pendingProposals(client.id)
    expect(open).toHaveLength(1)
    expect(open[0].payload.name).toBe('Push B')
  })

  it('refuses a proposal from someone who is not the coach', async () => {
    const { client, link } = await linked()
    const stranger = await createUser({ name: 'Nosy' })
    await expect(proposeRoutine({
      linkId: link.id, coachId: stranger.id, routineId: 'r1', payload: plan
    })).rejects.toMatchObject({ status: 403 })
    expect(await pendingProposals(client.id)).toHaveLength(0)
  })

  it('refuses a proposal when programmes were never shared', async () => {
    const { coach, client, link } = await linked(['workouts'])
    await expect(proposeRoutine({
      linkId: link.id, coachId: coach.id, routineId: 'r1', payload: plan
    })).rejects.toMatchObject({ status: 403 })
    expect(await pendingProposals(client.id)).toHaveLength(0)
  })

  it('cannot be accepted by anyone but its target', async () => {
    const { coach, client, link } = await linked()
    await proposeRoutine({ linkId: link.id, coachId: coach.id, routineId: 'r1', payload: plan })
    const [open] = await pendingProposals(client.id)
    await expect(acceptProposal({ revisionId: open.id, clientId: coach.id }))
      .rejects.toMatchObject({ status: 404 })
  })
})

describe('roster', () => {
  const session = (id, at) => ({
    id, started_at: at, finished_at: at, routine_id: 'r1', routine_name: 'Push', prs: [], sets: []
  })

  it('counts finished sessions, not abandoned ones', async () => {
    const { coach, client } = await linked()
    await push(client.id, {
      workouts: [
        session('w1', new Date(Date.now() - 2 * 864e5).toISOString()),
        { ...session('w2', new Date(Date.now() - 864e5).toISOString()), finished_at: null }
      ]
    })
    const [row] = await roster(coach.id)
    expect(row.stats.sessions).toBe(1)
  })

  it('reports adherence against the client\'s weekly plan', async () => {
    const { coach, client } = await linked()
    await push(client.id, {
      weekPlan: [{ weekday: 1, routine_id: 'r1' }, { weekday: 3, routine_id: 'r1' },
                 { weekday: 5, routine_id: 'r1' }],
      workouts: Array.from({ length: 6 }, (_, i) =>
        session(`w${i}`, new Date(Date.now() - (i + 1) * 864e5).toISOString()))
    })
    const [row] = await roster(coach.id, { days: 14 })
    expect(row.stats.expected).toBe(6)
    expect(row.stats.adherence).toBeCloseTo(1, 1)
  })

  it('says nothing rather than 0% when a client has no schedule', async () => {
    const { coach } = await linked()
    const [row] = await roster(coach.id)
    expect(row.stats.adherence).toBeNull()
  })

  it('surfaces open proposals and unread messages per client', async () => {
    const { coach, client, link } = await linked()
    await proposeRoutine({ linkId: link.id, coachId: coach.id, routineId: 'r1', payload: plan })
    await sendMessage({ linkId: link.id, senderId: client.id, body: 'shoulder is sore' })
    const [row] = await roster(coach.id)
    expect(row.stats.pendingProposals).toBe(1)
    expect(row.stats.unreadMessages).toBe(1)
  })

  it('shows a client who has not accepted yet, without stats', async () => {
    const { coach } = await pair()
    const [row] = await roster(coach.id)
    expect(row.status).toBe('pending')
    expect(row.stats).toBeNull()
  })

  it('never shows another coach\'s clients', async () => {
    await linked()
    const other = await createUser({ name: 'Other coach', isCoach: true })
    expect(await roster(other.id)).toHaveLength(0)
  })
})

describe('messages', () => {
  it('carries a note pinned to a specific session', async () => {
    const { coach, client, link } = await linked()
    await push(client.id, {
      workouts: [{
        id: 'w1', started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
        routine_id: 'r1', routine_name: 'Push', prs: [], sets: []
      }]
    })
    await sendMessage({ linkId: link.id, senderId: coach.id, body: 'lockout looked slow', workoutId: 'w1' })
    const thread = await readThread({ linkId: link.id, userId: client.id })
    expect(thread[0]).toMatchObject({ body: 'lockout looked slow', workout_id: 'w1' })
    expect(thread[0].sender_name).toBe('Coach')
  })

  it('marks the other side\'s messages read when the thread is opened', async () => {
    const { coach, client, link } = await linked()
    await sendMessage({ linkId: link.id, senderId: client.id, body: 'hi' })
    expect((await roster(coach.id))[0].stats.unreadMessages).toBe(1)
    await readThread({ linkId: link.id, userId: coach.id })
    expect((await roster(coach.id))[0].stats.unreadMessages).toBe(0)
  })

  it('keeps strangers out of the conversation', async () => {
    const { link } = await linked()
    const stranger = await createUser({ name: 'Nosy' })
    await expect(sendMessage({ linkId: link.id, senderId: stranger.id, body: 'hello' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(readThread({ linkId: link.id, userId: stranger.id }))
      .rejects.toMatchObject({ status: 403 })
  })
})
