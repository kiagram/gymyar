/* Scheduled notifications: whether the right person is owed one, at the right hour, once.
 *
 * The clock is injected, so "it is six in the evening in Tehran" is a value rather than a wait.
 * `send` is injected too — what these assert is the deciding, not the pushing, which `notify.js`
 * covers and which reaches nobody in a test anyway.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'
import { claim } from '@gymyar/db/reminders.js'
import { hourIn, dayIn, dueDateFor, remindOnce } from './reminders.js'

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

const TEHRAN = 'Asia/Tehran'

/* 18:00 in Tehran on Wednesday 26 August 2026. Tehran is UTC+3:30 and has not observed DST
 * since 2022, so this is 14:30 UTC. */
const SIX_PM_TEHRAN = new Date('2026-08-26T14:30:00Z')

const signUp = async (name, email) => {
  const c = client(app)
  const r = await c.post('/api/register/password', { name, email, password: 'correct-horse-battery' })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

describe('what time it is where somebody is', () => {
  it('is their hour, not the server\'s', () => {
    expect(hourIn(TEHRAN, SIX_PM_TEHRAN)).toBe(18)
    expect(hourIn('UTC', SIX_PM_TEHRAN)).toBe(14)
    expect(hourIn('America/Los_Angeles', SIX_PM_TEHRAN)).toBe(7)
  })

  it('is their calendar day too, which differs either side of midnight', () => {
    const lateInTehran = new Date('2026-08-26T20:30:00Z')   // just past midnight there
    expect(dayIn(TEHRAN, lateInTehran)).toBe('2026-08-27')
    expect(dayIn('UTC', lateInTehran)).toBe('2026-08-26')
  })

  it('says nothing rather than guessing for a timezone Intl does not know', () => {
    expect(hourIn('Mars/Olympus', SIX_PM_TEHRAN)).toBeNull()
  })
})

describe('which check-in a reminder is about', () => {
  it('is the one in the reader\'s own week', () => {
    // Wednesday 26 August, Saturday check-in, Persian week → this week began on the 22nd.
    expect(dueDateFor({ tz: TEHRAN, locale: 'fa', weekday: 6 }, SIX_PM_TEHRAN)).toBe('2026-08-22')
    // The same client on an English profile has a Monday week, so the 22nd is last week's and
    // the Saturday being asked about is the 29th.
    expect(dueDateFor({ tz: TEHRAN, locale: 'en', weekday: 6 }, SIX_PM_TEHRAN)).toBe('2026-08-29')
  })

  it('does not move as the week goes on', () => {
    const thursday = new Date('2026-08-27T14:30:00Z')
    expect(dueDateFor({ tz: TEHRAN, locale: 'fa', weekday: 6 }, thursday)).toBe('2026-08-22')
  })
})

describe('a claim', () => {
  it('is won once and then never again', async () => {
    const { user } = await signUp('Ada', 'ada@x.test')
    expect(await claim(user.id, 'checkin_due', '2026-08-22')).toBe(true)
    // The second caller is the other container, or the next tick fifteen minutes later.
    expect(await claim(user.id, 'checkin_due', '2026-08-22')).toBe(false)
  })

  it('is per person, per kind, and per key', async () => {
    const a = await signUp('Ada', 'ada@x.test')
    const b = await signUp('Bo', 'bo@x.test')
    expect(await claim(a.user.id, 'checkin_due', '2026-08-22')).toBe(true)
    expect(await claim(b.user.id, 'checkin_due', '2026-08-22')).toBe(true)
    expect(await claim(a.user.id, 'coach_digest', '2026-08-22')).toBe(true)
    expect(await claim(a.user.id, 'checkin_due', '2026-08-29')).toBe(true)
  })
})

describe('the check-in reminder', () => {
  /* A Persian client with a Saturday check-in and a coach who scheduled it. */
  const scheduled = async ({ tz = TEHRAN, locale = 'fa', weekday = 6 } = {}) => {
    const coach = await signUp('Coach Kim', 'kim@x.test')
    const client_ = await signUp('Sam', 'sam@x.test')
    const inv = await coach.c.post('/api/coach/invites', { email: 'sam@x.test' })
    await client_.c.post(`/api/invites/${inv.body.invite.code}/accept`)

    const tpl = await coach.c.post('/api/coach/checkin-templates', {
      title: 'Weekly', fields: [{ key: 'sleep', type: 'scale', label: 'Sleep' }]
    })
    await coach.c.post(`/api/coach/clients/${client_.user.id}/checkin-schedule`, {
      templateId: tpl.body.template.id, weekday
    })
    await db()`update users set locale = ${locale} where id = ${client_.user.id}`
    if (tz) {
      await db()`insert into user_settings (user_id, settings)
                 values (${client_.user.id}, ${db().json({ reminder: { tz } })})
                 on conflict (user_id) do update set settings = excluded.settings`
    }
    return { coach, client_, template: tpl.body.template }
  }

  const run = (now, sent = []) =>
    remindOnce({ now, send: async (u, k, a) => { sent.push({ u, k, a }) } }).then(r => ({ r, sent }))

  it('goes out at six in the evening where they are', async () => {
    const { client_ } = await scheduled()
    const { r, sent } = await run(SIX_PM_TEHRAN)
    expect(r.checkins).toBe(1)
    expect(sent[0]).toMatchObject({ u: client_.user.id, k: 'checkin_due' })
  })

  it('does not go out at three in the morning where they are', async () => {
    await scheduled()
    // Same instant is a perfectly ordinary hour on the server and the middle of the night there.
    const { r } = await run(new Date('2026-08-25T23:30:00Z'))
    expect(r.checkins).toBe(0)
  })

  it('goes out once, however many times the timer fires within the hour', async () => {
    await scheduled()
    const first = await run(SIX_PM_TEHRAN)
    expect(first.r.checkins).toBe(1)
    // 18:15, 18:30, 18:45 — the claim is what makes these silent.
    for (const m of ['14:45', '15:00', '15:15']) {
      const again = await run(new Date(`2026-08-26T${m}:00Z`))
      expect(again.r.checkins).toBe(0)
    }
  })

  it('does not go out to somebody who has already answered this week', async () => {
    const { client_, template } = await scheduled()
    await client_.c.post('/api/sync', {
      changes: {
        checkins: [{
          on_date: '2026-08-22', template_id: template.id,
          answers: { sleep: 4 }, submitted_at: '2026-08-22T09:00:00Z'
        }]
      }
    })
    const { r } = await run(SIX_PM_TEHRAN)
    expect(r.checkins).toBe(0)
  })

  it('still goes out to somebody whose only answer was last week', async () => {
    const { client_, template } = await scheduled()
    await client_.c.post('/api/sync', {
      changes: {
        checkins: [{
          on_date: '2026-08-15', template_id: template.id,
          answers: { sleep: 4 }, submitted_at: '2026-08-15T09:00:00Z'
        }]
      }
    })
    expect((await run(SIX_PM_TEHRAN)).r.checkins).toBe(1)
  })

  it('does not go out before the day it is due', async () => {
    // An English profile's Saturday is the 29th; on Wednesday there is nothing to chase.
    await scheduled({ locale: 'en' })
    expect((await run(SIX_PM_TEHRAN)).r.checkins).toBe(0)
  })

  it('stops when the coach archives the questions', async () => {
    const { coach, template } = await scheduled()
    await coach.c.del(`/api/coach/checkin-templates/${template.id}`)
    // Reminding somebody about a form nobody will read is worse than silence.
    expect((await run(SIX_PM_TEHRAN)).r.checkins).toBe(0)
  })

  it('stops when the client withdraws the scope', async () => {
    const { client_ } = await scheduled()
    const [link] = await db()`select id from coaching_links where client_id = ${client_.user.id}`
    await client_.c.post(`/api/coaches/${link.id}/scopes`, { scopes: ['programmes'] })
    expect((await run(SIX_PM_TEHRAN)).r.checkins).toBe(0)
  })

  it('honours an opt-out, and still does not ask again tomorrow', async () => {
    const { client_ } = await scheduled()
    await db()`update user_settings
               set settings = settings || ${db().json({ push: { checkin_due: false } })}
               where user_id = ${client_.user.id}`
    // `notify` is what checks the preference, so the real send is used here rather than a spy.
    const r = await remindOnce({ now: SIX_PM_TEHRAN })
    expect(r.checkins).toBe(0)
  })
})

describe('the coach digest', () => {
  const EIGHT_AM_TEHRAN = new Date('2026-08-26T04:30:00Z')

  const withClient = async () => {
    const coach = await signUp('Coach Kim', 'kim@x.test')
    const client_ = await signUp('Sam', 'sam@x.test')
    const inv = await coach.c.post('/api/coach/invites', { email: 'sam@x.test' })
    await client_.c.post(`/api/invites/${inv.body.invite.code}/accept`)
    await db()`insert into user_settings (user_id, settings)
               values (${coach.user.id}, ${db().json({ reminder: { tz: TEHRAN } })})
               on conflict (user_id) do update set settings = excluded.settings`
    return { coach, client_ }
  }

  const run = (now, sent = []) =>
    remindOnce({ now, send: async (u, k, a) => { sent.push({ u, k, a }) } }).then(r => ({ r, sent }))

  it('counts a client who has not trained in a fortnight', async () => {
    const { coach } = await withClient()
    const { r, sent } = await run(EIGHT_AM_TEHRAN)
    expect(r.digests).toBe(1)
    expect(sent[0]).toMatchObject({ u: coach.user.id, k: 'coach_digest' })
    expect(sent[0].a.quiet).toBe(1)
  })

  it('counts a check-in answered since yesterday', async () => {
    const { coach, client_ } = await withClient()
    await client_.c.post('/api/sync', {
      changes: {
        workouts: [{
          id: 'w1', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), sets: []
        }],
        checkins: [{ on_date: '2026-08-22', answers: { x: 1 }, submitted_at: new Date().toISOString() }]
      }
    })
    const { sent } = await run(EIGHT_AM_TEHRAN)
    expect(sent[0].a).toMatchObject({ answered: 1, quiet: 0 })
  })

  it('says nothing at all when there is nothing to say', async () => {
    const { client_ } = await withClient()
    // Training recently is the whole of what stops a client counting as quiet.
    await client_.c.post('/api/sync', {
      changes: {
        workouts: [{
          id: 'w1', started_at: new Date().toISOString(), finished_at: new Date().toISOString(), sets: []
        }]
      }
    })
    // A daily push reading "0 and 0" is why people turn digests off.
    expect((await run(EIGHT_AM_TEHRAN)).r.digests).toBe(0)
  })

  it('goes out in the morning, not the evening', async () => {
    await withClient()
    expect((await run(SIX_PM_TEHRAN)).r.digests).toBe(0)
    expect((await run(EIGHT_AM_TEHRAN)).r.digests).toBe(1)
  })
})

describe('when a send fails', () => {
  it('gives the claim back, so the next tick tries again', async () => {
    const coach = await signUp('Coach Kim', 'kim@x.test')
    const client_ = await signUp('Sam', 'sam@x.test')
    const inv = await coach.c.post('/api/coach/invites', { email: 'sam@x.test' })
    await client_.c.post(`/api/invites/${inv.body.invite.code}/accept`)
    await db()`insert into user_settings (user_id, settings)
               values (${coach.user.id}, ${db().json({ reminder: { tz: TEHRAN } })})
               on conflict (user_id) do update set settings = excluded.settings`

    const boom = async () => { throw new Error('push endpoint unreachable') }
    const first = await remindOnce({ now: new Date('2026-08-26T04:30:00Z'), send: boom })
    expect(first.digests).toBe(0)
    expect(first.failed).toBeGreaterThan(0)

    // A permanent silence caused by one bad fifteen minutes is the failure this avoids.
    const sent = []
    const second = await remindOnce({
      now: new Date('2026-08-26T04:45:00Z'),
      send: async (u, k, a) => { sent.push({ u, k, a }) }
    })
    expect(second.digests).toBe(1)
  })
})
