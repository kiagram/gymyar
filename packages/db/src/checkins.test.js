/* Check-ins across the seam: a coach owns the questions, a client owns every answer.
 *
 * The rule under test in most of this is the same one `coaching.test.js` holds for programmes —
 * there is one writer per row, and for an answer it is the person answering.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import { createUser } from './users.js'
import { push, pullAll, pull } from './sync.js'
import { inviteClient, acceptInvite, setScopes, SCOPES } from './coaching.js'
import {
  saveTemplate, templatesOf, archiveTemplate,
  scheduleCheckin, unscheduleCheckin, scheduleFor,
  clientCheckins, lastCheckins
} from './checkins.js'
import { db } from './index.js'

beforeAll(async () => { await setupDb() })
beforeEach(async () => { await truncateUsers() })
afterAll(async () => { await teardownDb() })

const linked = async (scopes = ['programmes', 'workouts', 'checkins']) => {
  const coach = await createUser({ name: 'Coach', email: 'coach@x.test', isCoach: true })
  const client = await createUser({ name: 'Client', email: 'client@x.test' })
  const invite = await inviteClient({ coachId: coach.id, email: client.email, scopes })
  const link = await acceptInvite({ inviteCode: invite.invite_code, clientId: client.id })
  return { coach, client, link }
}

const FIELDS = [
  { key: 'sleep', type: 'scale', label: 'Sleep', required: true },
  { key: 'waist', type: 'measure', label: 'Waist', min: 40, max: 200, unit: 'cm' },
  { key: 'notes', type: 'text', label: 'Notes' }
]

describe('the scope', () => {
  it('is one a client can grant, and one an invitation asks for by default', () => {
    expect(SCOPES).toContain('checkins')
  })

  it('is in the default invitation, unlike photos', async () => {
    const coach = await createUser({ name: 'Coach', isCoach: true })
    const invite = await inviteClient({ coachId: coach.id })
    expect(invite.scopes).toContain('checkins')
    expect(invite.scopes).not.toContain('photos')
  })
})

describe('a coach\'s template', () => {
  it('is saved with its fields validated by the domain', async () => {
    const { coach } = await linked()
    const t = await saveTemplate({
      coachId: coach.id,
      title: 'Weekly',
      // 11 is not a scale bound, and a field with no key is not a field.
      fields: [...FIELDS, { type: 'scale', label: 'nameless' }]
    })
    expect(t.fields.map(f => f.key)).toEqual(['sleep', 'waist', 'notes'])
    expect(t.title).toBe('Weekly')
  })

  it('cannot be edited by another coach', async () => {
    const { coach } = await linked()
    const other = await createUser({ name: 'Other', isCoach: true })
    const t = await saveTemplate({ coachId: coach.id, title: 'Weekly', fields: FIELDS })
    await expect(saveTemplate({ coachId: other.id, id: t.id, title: 'Mine now', fields: [] }))
      .rejects.toMatchObject({ status: 404 })
  })

  it('is archived rather than deleted, so old answers keep their questions', async () => {
    const { coach } = await linked()
    const t = await saveTemplate({ coachId: coach.id, title: 'Weekly', fields: FIELDS })
    await archiveTemplate({ coachId: coach.id, id: t.id })

    expect(await templatesOf(coach.id)).toHaveLength(0)
    const [still] = await db()`select * from checkin_templates where id = ${t.id}`
    expect(still).toBeTruthy()
  })
})

describe('putting a template on a client', () => {
  it('replaces rather than stacks, because a week has one check-in', async () => {
    const { coach, link } = await linked()
    const a = await saveTemplate({ coachId: coach.id, title: 'A', fields: FIELDS })
    const b = await saveTemplate({ coachId: coach.id, title: 'B', fields: FIELDS })

    await scheduleCheckin({ coachId: coach.id, linkId: link.id, templateId: a.id, weekday: 6 })
    await scheduleCheckin({ coachId: coach.id, linkId: link.id, templateId: b.id, weekday: 1 })

    const sc = await scheduleFor(link.id)
    expect(sc.template_id).toBe(b.id)
    expect(sc.weekday).toBe(1)
  })

  it('refuses somebody else\'s client', async () => {
    const { coach, link } = await linked()
    const stranger = await createUser({ name: 'Nosy', isCoach: true })
    const t = await saveTemplate({ coachId: stranger.id, title: 'Theirs', fields: FIELDS })
    await expect(scheduleCheckin({
      coachId: stranger.id, linkId: link.id, templateId: t.id, weekday: 6
    })).rejects.toMatchObject({ status: 403 })
    expect(await scheduleFor(link.id)).toBeNull()
  })

  it('refuses a template belonging to another coach', async () => {
    const { coach, link } = await linked()
    const other = await createUser({ name: 'Other', isCoach: true })
    const theirs = await saveTemplate({ coachId: other.id, title: 'Theirs', fields: FIELDS })
    await expect(scheduleCheckin({
      coachId: coach.id, linkId: link.id, templateId: theirs.id, weekday: 6
    })).rejects.toMatchObject({ status: 403 })
  })

  it('refuses a weekday that is not one', async () => {
    const { coach, link } = await linked()
    const t = await saveTemplate({ coachId: coach.id, title: 'A', fields: FIELDS })
    await expect(scheduleCheckin({ coachId: coach.id, linkId: link.id, templateId: t.id, weekday: 9 }))
      .rejects.toMatchObject({ status: 400 })
  })

  it('can be taken off again', async () => {
    const { coach, link } = await linked()
    const t = await saveTemplate({ coachId: coach.id, title: 'A', fields: FIELDS })
    await scheduleCheckin({ coachId: coach.id, linkId: link.id, templateId: t.id, weekday: 6 })
    expect(await unscheduleCheckin({ coachId: coach.id, linkId: link.id })).toBeTruthy()
    expect(await scheduleFor(link.id)).toBeNull()
  })
})

describe('an answer is the client\'s own row', () => {
  it('is written through their sync and comes back on the next pull', async () => {
    const { client } = await linked()
    const before = await pullAll(client.id)
    await push(client.id, {
      checkins: [{ on_date: '2026-08-22', answers: { sleep: 4, notes: 'good week' }, submitted_at: new Date() }]
    })
    const delta = await pull(client.id, before.cursor)
    expect(delta.changes.checkins).toHaveLength(1)
    expect(delta.changes.checkins[0].answers).toEqual({ sleep: 4, notes: 'good week' })
  })

  it('merges two devices answering the same day instead of colliding', async () => {
    // The reason the key is (user, date) and not a per-device id: an id generated twice for one
    // Saturday would push two rows and fail the whole transaction.
    const { client } = await linked()
    await push(client.id, { checkins: [{ on_date: '2026-08-22', answers: { sleep: 3 } }] })
    await push(client.id, { checkins: [{ on_date: '2026-08-22', answers: { sleep: 5 } }] })

    const all = (await pullAll(client.id)).changes.checkins
    expect(all).toHaveLength(1)
    expect(all[0].answers.sleep).toBe(5)
  })

  it('survives the deletion of the coach whose questions it answered', async () => {
    const { coach, client } = await linked()
    const t = await saveTemplate({ coachId: coach.id, title: 'Weekly', fields: FIELDS })
    await push(client.id, {
      checkins: [{ on_date: '2026-08-22', template_id: t.id, answers: { sleep: 4 }, submitted_at: new Date() }]
    })

    await db()`delete from users where id = ${coach.id}`

    const all = (await pullAll(client.id)).changes.checkins
    expect(all).toHaveLength(1)                       // the answers were never the coach's
    expect(all[0].template_id).toBeNull()             // only the wording is gone
    expect(all[0].answers.sleep).toBe(4)
  })

  it('is gone from a pull once deleted, and says so to a client catching up', async () => {
    const { client } = await linked()
    await push(client.id, { checkins: [{ on_date: '2026-08-22', answers: { sleep: 4 } }] })
    const mid = await pullAll(client.id)
    await push(client.id, { checkins: [{ on_date: '2026-08-22', deleted: true }] })

    expect((await pullAll(client.id)).changes.checkins).toHaveLength(0)
    const delta = await pull(client.id, mid.cursor)
    expect(delta.changes.checkins[0].deleted_at).toBeTruthy()
  })
})

describe('what a coach may read', () => {
  const answered = async (client, on = '2026-08-22', extra = {}) =>
    push(client.id, {
      checkins: [{ on_date: on, answers: { sleep: 4 }, submitted_at: new Date(), ...extra }]
    })

  it('reads the answers when the scope was granted', async () => {
    const { coach, client } = await linked()
    await answered(client)
    const rows = await clientCheckins({ coachId: coach.id, clientId: client.id })
    expect(rows).toHaveLength(1)
    expect(rows[0].answers.sleep).toBe(4)
  })

  it('is refused when it was not', async () => {
    const { coach, client } = await linked(['programmes', 'workouts'])
    await answered(client)
    await expect(clientCheckins({ coachId: coach.id, clientId: client.id }))
      .rejects.toMatchObject({ status: 403 })
  })

  it('stops reading the moment the client revokes it', async () => {
    const { coach, client, link } = await linked()
    await answered(client)
    await setScopes({ linkId: link.id, clientId: client.id, scopes: ['programmes'] })
    await expect(clientCheckins({ coachId: coach.id, clientId: client.id }))
      .rejects.toMatchObject({ status: 403 })
  })

  it('never sees a draft somebody is halfway through', async () => {
    const { coach, client } = await linked()
    await push(client.id, { checkins: [{ on_date: '2026-08-22', answers: { notes: 'I am still' } }] })
    expect(await clientCheckins({ coachId: coach.id, clientId: client.id })).toHaveLength(0)
  })

  it('reads answers given before this coach arrived, because the scope is what grants them', async () => {
    const client = await createUser({ name: 'Client', email: 'c@x.test' })
    await push(client.id, {
      checkins: [{ on_date: '2026-07-04', answers: { sleep: 2 }, submitted_at: new Date() }]
    })
    const coach = await createUser({ name: 'Coach', email: 'co@x.test', isCoach: true })
    const invite = await inviteClient({ coachId: coach.id, email: client.email, scopes: ['checkins'] })
    await acceptInvite({ inviteCode: invite.invite_code, clientId: client.id })

    expect(await clientCheckins({ coachId: coach.id, clientId: client.id })).toHaveLength(1)
  })

  it('answers the whole roster in one query, and leaves out who has not shared', async () => {
    const coach = await createUser({ name: 'Coach', email: 'co@x.test', isCoach: true })
    const shares = await createUser({ name: 'Shares', email: 's@x.test' })
    const does_not = await createUser({ name: 'Private', email: 'p@x.test' })
    const link = async (client, scopes) => {
      const inv = await inviteClient({ coachId: coach.id, email: client.email, scopes })
      return acceptInvite({ inviteCode: inv.invite_code, clientId: client.id })
    }
    const l1 = await link(shares, ['programmes', 'checkins'])
    await link(does_not, ['programmes'])

    const t = await saveTemplate({ coachId: coach.id, title: 'Weekly', fields: FIELDS })
    await scheduleCheckin({ coachId: coach.id, linkId: l1.id, templateId: t.id, weekday: 6 })
    await answered(shares, '2026-08-15')
    await answered(does_not, '2026-08-15')

    const map = await lastCheckins(coach.id, [shares.id, does_not.id])
    expect(map.get(shares.id)).toMatchObject({ weekday: 6 })
    // A calendar day, as a string. Not a Date: postgres.js would hand back UTC midnight, which
    // every local getter west of Greenwich reads as the day before.
    expect(map.get(shares.id).lastOn).toBe('2026-08-15')
    // Absent, not present-with-a-null: "has not answered" and "did not share" are different
    // sentences and a roster must not say the first when it means the second.
    expect(map.has(does_not.id)).toBe(false)
  })

  it('reports no last answer for a client who has shared but not replied', async () => {
    const { coach, client } = await linked()
    const map = await lastCheckins(coach.id, [client.id])
    expect(map.has(client.id)).toBe(true)
    expect(map.get(client.id).lastOn).toBeNull()
  })
})
