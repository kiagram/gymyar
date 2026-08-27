/* What a notification says, and who gets to stop it.
 *
 * The sending itself is web-push and is not tested here — it is one library call behind a VAPID
 * key. What is worth testing is everything around it: that a Persian reader gets Persian, that a
 * name is never mangled by the translator, that an opt-out is honoured, and above all that none
 * of this can break the thing it is announcing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'
import { translatorFor, wants, notify, otherSide, NOTIFY_KINDS } from './notify.js'

let app
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  app = await build({ databaseUrl: URL, rateLimit: false })
  const { seedExercises } = await import('@gymyar/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => { await db()`delete from users` })
afterAll(async () => { await app.close(); await close() })

const signUp = async (name, email) => {
  const c = client(app)
  const r = await c.post('/api/register/password', { name, email, password: 'correct-horse-battery' })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

describe('the wording', () => {
  it('is Persian for a Persian reader', () => {
    const t = translatorFor('fa')
    expect(t('New message')).toBe('پیام تازه')
    expect(t('{0} sent you a message', 'کیم')).toBe('کیم برایت پیام فرستاد')
  })

  it('is the English source string for a language with no pack', () => {
    // Readable rather than missing — the whole reason the keys are the English sentences.
    expect(translatorFor('ko')('New message')).toBe('New message')
    expect(translatorFor(null)('{0} sent you a message', 'Kim')).toBe('Kim sent you a message')
  })

  it('reads a regional tag as its language', () => {
    expect(translatorFor('fa-IR')('New message')).toBe('پیام تازه')
  })

  it('writes numbers in that language\'s digits and leaves names alone', () => {
    const t = translatorFor('fa')
    expect(t('{0} sent you a message', 3)).toBe('۳ برایت پیام فرستاد')
    // A name is somebody's name. Formatting it would be an edit, not a translation.
    expect(t('{0} sent you a message', 'Kim Alvarez')).toContain('Kim Alvarez')
  })
})

describe('who wants one', () => {
  const setPush = async (userId, value) =>
    db()`insert into user_settings (user_id, settings) values (${userId}, ${db().json({ push: value })})
         on conflict (user_id) do update set settings = excluded.settings`

  it('is everybody who has never said otherwise', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    for (const kind of NOTIFY_KINDS) expect(await wants(user.id, kind)).toBe(true)
  })

  it('is nobody, when the whole switch is off', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    await setPush(user.id, false)
    expect(await wants(user.id, 'message')).toBe(false)
  })

  it('is per kind, when that is what they chose', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    await setPush(user.id, { message: false })
    expect(await wants(user.id, 'message')).toBe(false)
    // Silence about one thing is not silence about everything.
    expect(await wants(user.id, 'proposal')).toBe(true)
  })

  it('is still everybody when their settings row says nothing about push', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    await db()`insert into user_settings (user_id, settings) values (${user.id}, ${db().json({ unit: 'kg' })})
               on conflict (user_id) do update set settings = excluded.settings`
    expect(await wants(user.id, 'message')).toBe(true)
  })
})

describe('sending', () => {
  it('reaches nobody, quietly, when there is no subscription', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    expect(await notify(user.id, 'message', { from: 'Kim' })).toBe(0)
  })

  it('says nothing at all for a kind that does not exist', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    expect(await notify(user.id, 'something_else', {})).toBe(0)
  })

  it('swallows a database failure rather than raising it at its caller', async () => {
    // The caller has just written a row. A notification is the last thing that should be able
    // to turn a sent message into a failed request.
    await expect(notify('not-a-uuid', 'message', { from: 'Kim' })).resolves.toBe(0)
  })
})

describe('the moments that send one', () => {
  /* These go through HTTP so the wiring is what is under test, not `notify` again. Nobody has a
   * push subscription, so every send reaches zero devices — the assertion is that the request
   * succeeded anyway, which is the property that matters. */
  const linked = async () => {
    const coach = await signUp('Coach Kim', 'kim@x.test')
    const client_ = await signUp('Sam', 'sam@x.test')
    const inv = await coach.c.post('/api/coach/invites', { email: 'sam@x.test' })
    await client_.c.post(`/api/invites/${inv.body.invite.code}/accept`)
    const [link] = await db()`select id from coaching_links where client_id = ${client_.user.id}`
    return { coach, client_, linkId: link.id }
  }

  it('a message still sends when the notification cannot', async () => {
    const { coach, linkId } = await linked()
    const r = await coach.c.post(`/api/threads/${linkId}`, { body: 'how did the week go?' })
    expect(r.status).toBe(200)
    expect(r.body.message.body).toBe('how did the week go?')
  })

  it('a proposal still sends, and is still there to accept', async () => {
    const { coach, client_ } = await linked()
    const p = await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      routineId: 'r1', payload: { name: 'Push A', exercises: [] }
    })
    expect(p.status).toBe(200)

    const [open] = (await client_.c.get('/api/proposals')).body.proposals
    expect((await client_.c.post(`/api/proposals/${open.id}/accept`)).status).toBe(200)
  })

  it('declining still works, and still tells the coach nothing they cannot see', async () => {
    const { coach, client_ } = await linked()
    await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      routineId: 'r1', payload: { name: 'Push A', exercises: [] }
    })
    const [open] = (await client_.c.get('/api/proposals')).body.proposals
    expect((await client_.c.post(`/api/proposals/${open.id}/decline`)).status).toBe(200)
    expect((await client_.c.get('/api/proposals')).body.proposals).toHaveLength(0)
  })

})

describe('who a message is announced to', () => {
  const link = { coach_id: 'coach-1', client_id: 'client-1' }

  it('is the other person, whichever of them wrote it', () => {
    // Backwards, this pushes every coach their own messages.
    expect(otherSide(link, 'coach-1')).toBe('client-1')
    expect(otherSide(link, 'client-1')).toBe('coach-1')
  })

  it('is nobody for a stranger, or for an invitation with no client yet', () => {
    expect(otherSide(link, 'somebody-else')).toBeNull()
    expect(otherSide({ coach_id: 'coach-1', client_id: null }, 'coach-1')).toBeNull()
    expect(otherSide(null, 'coach-1')).toBeNull()
  })
})
