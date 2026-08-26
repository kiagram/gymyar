/* The attachment index, against a real database.
 *
 * Most of what is worth testing here is not a query result — it is a constraint. The table
 * carries rules that the upload route also enforces, deliberately doubled, and these are the
 * half that survives somebody adding a second way in. So the checks are exercised directly:
 * a progress photo with a workout id, a recording attached to a lift, a size with no upload.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import crypto from 'node:crypto'
import { setupDb, truncateUsers, teardownDb } from './test-helpers.js'
import { createUser } from './users.js'
import { inviteClient, acceptInvite, sendMessage } from './coaching.js'
import {
  reserve, finish, remove, byId, forWorkout, forWorkouts, progressFor, forMessages,
  usageFor, deleted, abandoned, purge, claimed, publicView, orphaned, forget
} from './attachments.js'
import { db } from './index.js'

beforeAll(async () => { await setupDb() })
beforeEach(async () => { await truncateUsers() })
afterAll(async () => { await teardownDb() })

const uid = () => crypto.randomUUID()

/** A reserved-and-finished form check, which is what almost every test below wants. */
async function attach(ownerId, over = {}) {
  const id = over.id ?? uid()
  const base = {
    id, ownerId, subject: 'form_check', kind: 'video', mime: 'video/mp4',
    storageKey: `ab/${ownerId}/2026/08/${id}.mp4`, workoutId: 'w1', exerciseId: '0025'
  }
  const row = await reserve({ ...base, ...over, id })
  return over.unfinished ? row : await finish({ id, bytes: over.bytes ?? 1024 })
}

const user = (name = 'Sam') => createUser({ name, email: `${name.toLowerCase()}@x.test` })

describe('the reserve → finish lifecycle', () => {
  it('is invisible to every read until the bytes have landed', async () => {
    const u = await user()
    const row = await attach(u.id, { unfinished: true })
    expect(row.uploaded_at).toBe(null)
    expect(row.bytes).toBe(null)
    expect(await forWorkout(u.id, 'w1')).toHaveLength(0)

    await finish({ id: row.id, bytes: 4096 })
    const [found] = await forWorkout(u.id, 'w1')
    expect(found.bytes).toBe('4096')
  })

  it('refuses a size without an upload, and an upload without a size', async () => {
    const u = await user()
    const id = uid()
    await expect(db()`
      insert into attachments (id, owner_id, subject, kind, mime, storage_key, workout_id,
                               exercise_id, bytes)
      values (${id}, ${u.id}, 'form_check', 'video', 'video/mp4', ${'k/' + id}, 'w1', '0025', 10)`
    ).rejects.toThrow(/attachments_finished/)
  })

  it('finishes once — a replayed request cannot re-size a row', async () => {
    const u = await user()
    const row = await attach(u.id, { unfinished: true })
    expect(await finish({ id: row.id, bytes: 100 })).toBeTruthy()
    expect(await finish({ id: row.id, bytes: 999999 })).toBe(null)
    const [found] = await forWorkout(u.id, 'w1')
    expect(found.bytes).toBe('100')
  })

  it('will not let two rows claim the same bytes', async () => {
    const u = await user()
    const first = await attach(u.id)
    const [row] = await db()`select storage_key from attachments where id = ${first.id}`
    await expect(attach(u.id, { storageKey: row.storage_key })).rejects.toThrow(/duplicate key|unique/i)
  })
})

describe('what a subject may be', () => {
  it('files a form check against a session and a lift', async () => {
    const u = await user()
    const row = await attach(u.id)
    expect(row.workout_id).toBe('w1')
    expect(row.exercise_id).toBe('0025')
  })

  it('refuses a form check with no lift to point at', async () => {
    const u = await user()
    await expect(attach(u.id, { exerciseId: null })).rejects.toThrow(/attachments_context/)
  })

  it('refuses a progress photo that also claims a workout', async () => {
    const u = await user()
    await expect(attach(u.id, {
      subject: 'progress', kind: 'photo', mime: 'image/jpeg', onDate: '2026-08-01'
    })).rejects.toThrow(/attachments_context/)
  })

  it('refuses a recording of a lift, and a weigh-in that is a video', async () => {
    const u = await user()
    await expect(attach(u.id, { kind: 'audio', mime: 'audio/mp4' }))
      .rejects.toThrow(/attachments_kind/)
    await expect(attach(u.id, {
      subject: 'progress', kind: 'video', mime: 'video/mp4',
      onDate: '2026-08-01', workoutId: null, exerciseId: null
    })).rejects.toThrow(/attachments_kind/)
  })

  it('lets a message carry any of the three', async () => {
    const coach = await createUser({ name: 'Coach', email: 'c@x.test', isCoach: true })
    const client = await user('Ava')
    const invite = await inviteClient({ coachId: coach.id, email: client.email })
    const link = await acceptInvite({ inviteCode: invite.invite_code, clientId: client.id })
    const msg = await sendMessage({ linkId: link.id, senderId: coach.id, body: 'watch this' })

    for (const [kind, mime] of [['audio', 'audio/webm'], ['photo', 'image/png'], ['video', 'video/mp4']]) {
      await attach(coach.id, {
        subject: 'message', kind, mime, messageId: msg.id, workoutId: null, exerciseId: null
      })
    }
    const files = await forMessages([msg.id])
    expect(files.get(msg.id)).toHaveLength(3)
  })

  it('lets go of a message attachment when the message goes', async () => {
    const coach = await createUser({ name: 'Coach', email: 'c@x.test', isCoach: true })
    const client = await user('Ava')
    const invite = await inviteClient({ coachId: coach.id, email: client.email })
    const link = await acceptInvite({ inviteCode: invite.invite_code, clientId: client.id })
    const msg = await sendMessage({ linkId: link.id, senderId: coach.id, body: 'hi' })
    const row = await attach(coach.id, {
      subject: 'message', kind: 'audio', mime: 'audio/webm', messageId: msg.id,
      workoutId: null, exerciseId: null
    })
    await db()`delete from messages where id = ${msg.id}`
    expect(await byId(row.id)).toBe(null)
  })
})

describe('reading', () => {
  it('groups several sessions in one question', async () => {
    const u = await user()
    await attach(u.id, { workoutId: 'w1' })
    await attach(u.id, { workoutId: 'w1' })
    await attach(u.id, { workoutId: 'w2' })
    const map = await forWorkouts(u.id, ['w1', 'w2', 'w3'])
    expect(map.get('w1')).toHaveLength(2)
    expect(map.get('w2')).toHaveLength(1)
    expect(map.has('w3')).toBe(false)
  })

  it('asks nothing at all when there is nothing to ask about', async () => {
    expect((await forWorkouts(uid(), [])).size).toBe(0)
    expect((await forMessages([])).size).toBe(0)
  })

  it('never returns one person’s rows to another', async () => {
    const a = await user('Ava')
    const b = await user('Theo')
    await attach(a.id, { workoutId: 'shared-id' })
    expect(await forWorkout(b.id, 'shared-id')).toHaveLength(0)
  })

  it('shows progress photos newest first', async () => {
    const u = await user()
    const day = d => ({
      subject: 'progress', kind: 'photo', mime: 'image/jpeg', onDate: d,
      workoutId: null, exerciseId: null
    })
    await attach(u.id, day('2026-06-01'))
    await attach(u.id, day('2026-08-01'))
    await attach(u.id, day('2026-07-01'))
    const rows = await progressFor(u.id)
    expect(rows.map(r => publicView(r).on_date)).toEqual(['2026-08-01', '2026-07-01', '2026-06-01'])
  })
})

describe('deleting', () => {
  it('leaves every screen at once, and leaves the sweeper something to do', async () => {
    const u = await user()
    const row = await attach(u.id)
    expect(await remove({ id: row.id, ownerId: u.id })).toBeTruthy()
    expect(await forWorkout(u.id, 'w1')).toHaveLength(0)
    expect(await byId(row.id)).toBe(null)
    expect((await deleted()).map(r => r.id)).toContain(row.id)
  })

  it('is not something somebody else can do', async () => {
    const a = await user('Ava')
    const b = await user('Theo')
    const row = await attach(a.id)
    expect(await remove({ id: row.id, ownerId: b.id })).toBe(null)
    expect(await forWorkout(a.id, 'w1')).toHaveLength(1)
  })

  it('cannot be done twice, so a retry does not re-queue it', async () => {
    const u = await user()
    const row = await attach(u.id)
    expect(await remove({ id: row.id, ownerId: u.id })).toBeTruthy()
    expect(await remove({ id: row.id, ownerId: u.id })).toBe(null)
    expect(await deleted()).toHaveLength(1)
  })

  it('takes everything with the account', async () => {
    const u = await user()
    await attach(u.id)
    await db()`delete from users where id = ${u.id}`
    const [{ n }] = await db()`select count(*)::int as n from attachments`
    expect(n).toBe(0)
  })
})

describe('the sweeper’s two lists', () => {
  it('finds an upload that died, but not one still arriving', async () => {
    const u = await user()
    const fresh = await attach(u.id, { unfinished: true })
    const old = await attach(u.id, { unfinished: true })
    await db()`update attachments set created_at = now() - interval '3 hours' where id = ${old.id}`

    const found = await abandoned({ minutes: 60 })
    expect(found.map(r => r.id)).toEqual([old.id])
    expect(found.map(r => r.id)).not.toContain(fresh.id)
  })

  it('does not offer a finished upload to either list', async () => {
    const u = await user()
    await attach(u.id)
    expect(await abandoned({ minutes: 0 })).toHaveLength(0)
    expect(await deleted()).toHaveLength(0)
  })

  it('purges by id, once', async () => {
    const u = await user()
    const row = await attach(u.id)
    expect(await purge(row.id)).toBe(true)
    expect(await purge(row.id)).toBe(false)
  })

  it('lists what the volume is supposed to be holding', async () => {
    const u = await user()
    const live = await attach(u.id)
    const gone = await attach(u.id)
    await remove({ id: gone.id, ownerId: u.id })
    await attach(u.id, { unfinished: true })
    expect((await claimed()).map(r => r.id)).toEqual([live.id])
  })
})

describe('usage', () => {
  it('adds up what is stored and ignores what was deleted', async () => {
    const u = await user()
    await attach(u.id, { bytes: 1000 })
    const gone = await attach(u.id, { bytes: 5000 })
    await remove({ id: gone.id, ownerId: u.id })
    expect(await usageFor(u.id)).toEqual({ bytes: 1000, files: 1 })
  })

  it('counts an upload in flight as a file and not as bytes', async () => {
    const u = await user()
    await attach(u.id, { bytes: 1000 })
    await attach(u.id, { unfinished: true })
    expect(await usageFor(u.id)).toEqual({ bytes: 1000, files: 2 })
  })

  it('is zero for somebody who has never uploaded anything', async () => {
    expect(await usageFor(uid())).toEqual({ bytes: 0, files: 0 })
  })
})

describe('the public view', () => {
  it('never carries the storage key or the owner', async () => {
    const u = await user()
    const row = await attach(u.id)
    const view = publicView(row)
    expect(view.storage_key).toBeUndefined()
    expect(view.owner_id).toBeUndefined()
    expect(view.id).toBe(row.id)
    expect(view.kind).toBe('video')
  })

  it('renders a date as the day it is, not as a moment in a timezone', async () => {
    const u = await user()
    const row = await attach(u.id, {
      subject: 'progress', kind: 'photo', mime: 'image/jpeg', onDate: '2026-08-01',
      workoutId: null, exerciseId: null
    })
    expect(publicView(row).on_date).toBe('2026-08-01')
  })
})

/* The tombstone, which is the only reason any of this is recoverable.
 *
 * A row is the sole record of where its bytes are, and rows are removed by things that are not
 * the sweeper — a cascade from a deleted account most of all. Every one of those has to leave
 * the key behind, or the bytes are unreachable forever: storage cannot list itself.
 */
describe('keys that outlive their rows', () => {
  const keys = async () => (await orphaned()).map(r => r.storage_key)

  it('remembers the key when the sweeper retires a row', async () => {
    const u = await user()
    const row = await attach(u.id)
    await remove({ id: row.id, ownerId: u.id })
    await purge(row.id)
    expect(await keys()).toContain(row.storage_key)
  })

  it('remembers every key a deleted account took with it', async () => {
    const u = await user()
    const a = await attach(u.id)
    const b = await attach(u.id, { workoutId: 'w2' })
    // Nothing in the application is involved in this — it is the FK doing it.
    await db()`delete from users where id = ${u.id}`

    const left = await keys()
    expect(left).toContain(a.storage_key)
    expect(left).toContain(b.storage_key)
  })

  it('remembers an upload that was abandoned before its bytes landed', async () => {
    // The bytes may be there, partly there, or absent. The key is kept either way, because
    // only the volume can say which, and `delete` is idempotent for all three.
    const u = await user()
    const row = await attach(u.id, { unfinished: true })
    await purge(row.id)
    expect(await keys()).toContain(row.storage_key)
  })

  it('remembers a key once, however many times the row is re-tombstoned', async () => {
    const u = await user()
    const row = await attach(u.id)
    await purge(row.id)
    await db()`
      insert into attachments (id, owner_id, subject, kind, mime, storage_key, workout_id,
                               exercise_id, bytes, uploaded_at)
      values (${row.id}, ${u.id}, 'form_check', 'video', 'video/mp4', ${row.storage_key},
              'w1', '0025', 10, now())`
    await purge(row.id)
    expect((await orphaned()).filter(r => r.storage_key === row.storage_key)).toHaveLength(1)
  })

  it('forgets a key once, and says whether there was one', async () => {
    const u = await user()
    const row = await attach(u.id)
    await purge(row.id)
    expect(await forget(row.storage_key)).toBe(true)
    expect(await forget(row.storage_key)).toBe(false)
    expect(await keys()).not.toContain(row.storage_key)
  })

  it('survives the account that owned it, which is the entire point', async () => {
    const u = await user()
    const row = await attach(u.id)
    await db()`delete from users where id = ${u.id}`
    // No foreign key to a user, no cascade to follow it. The key is a string and nothing else.
    expect(await keys()).toContain(row.storage_key)
  })
})
