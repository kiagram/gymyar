/* Check-ins and habits over HTTP.
 *
 * What these are really testing is a boundary: almost nothing a *client* does here goes through
 * an endpoint of its own. A filled-in check-in and a ticked habit are pushed through `/api/sync`
 * with everything else they own, and the only thing the server tells them is which questions
 * they are being asked. So most of what follows is a coach asking, and a client answering
 * somewhere else entirely.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { build } from './app.js'
import { client } from './test-client.js'
import { db, close } from '@gymyar/db'

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
  const r = await c.post('/api/register/password', {
    name, email, password: 'correct-horse-battery'
  })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

const FIELDS = [
  { key: 'sleep', type: 'scale', label: 'Sleep', required: true },
  { key: 'notes', type: 'text', label: 'Notes' }
]

/** A coach and a linked client, sharing whatever the caller names. */
const pair = async (scopes = ['programmes', 'workouts', 'checkins', 'habits']) => {
  const coach = await signUp('Coach Kim', 'kim@x.test')
  const client_ = await signUp('Sam', 'sam@x.test')
  const inv = await coach.c.post('/api/coach/invites', { email: 'sam@x.test', scopes })
  await client_.c.post(`/api/invites/${inv.body.invite.code}/accept`)
  return { coach, client_ }
}

const withTemplate = async (coach, client_, weekday = 6) => {
  const t = await coach.c.post('/api/coach/checkin-templates', { title: 'Weekly', fields: FIELDS })
  expect(t.status).toBe(200)
  const sc = await coach.c.post(`/api/coach/clients/${client_.user.id}/checkin-schedule`, {
    templateId: t.body.template.id, weekday
  })
  expect(sc.status).toBe(200)
  return t.body.template
}

describe('a coach\'s check-in template', () => {
  it('is created, listed, and archived', async () => {
    const { coach } = await pair()
    const made = await coach.c.post('/api/coach/checkin-templates', { title: 'Weekly', fields: FIELDS })
    expect(made.body.template.fields.map(f => f.key)).toEqual(['sleep', 'notes'])

    expect((await coach.c.get('/api/coach/checkin-templates')).body.templates).toHaveLength(1)
    expect((await coach.c.del(`/api/coach/checkin-templates/${made.body.template.id}`)).status).toBe(200)
    expect((await coach.c.get('/api/coach/checkin-templates')).body.templates).toHaveLength(0)
  })

  it('belongs to its coach and nobody else', async () => {
    const { coach } = await pair()
    const made = await coach.c.post('/api/coach/checkin-templates', { title: 'Weekly', fields: FIELDS })
    const nosy = await signUp('Nosy', 'nosy@x.test')

    expect((await nosy.c.get('/api/coach/checkin-templates')).body.templates).toHaveLength(0)
    expect((await nosy.c.post('/api/coach/checkin-templates', {
      id: made.body.template.id, title: 'Mine now', fields: []
    })).status).toBe(404)
    expect((await nosy.c.del(`/api/coach/checkin-templates/${made.body.template.id}`)).status).toBe(404)
  })

  it('needs a signed-in account at all', async () => {
    const anon = client(app)
    expect((await anon.get('/api/coach/checkin-templates')).status).toBe(401)
    expect((await anon.get('/api/checkin')).status).toBe(401)
  })
})

describe('putting a check-in on a client', () => {
  it('shows up as the questions that client is asked', async () => {
    const { coach, client_ } = await pair()
    await withTemplate(coach, client_)

    const mine = await client_.c.get('/api/checkin')
    expect(mine.body.scheduled).toHaveLength(1)
    expect(mine.body.scheduled[0]).toMatchObject({ title: 'Weekly', weekday: 6, coachName: 'Coach Kim' })
    expect(mine.body.scheduled[0].fields.map(f => f.key)).toEqual(['sleep', 'notes'])
  })

  it('is refused for somebody else\'s client', async () => {
    const { coach, client_ } = await pair()
    const nosy = await signUp('Nosy', 'nosy@x.test')
    const t = await coach.c.post('/api/coach/checkin-templates', { title: 'Weekly', fields: FIELDS })
    expect((await nosy.c.post(`/api/coach/clients/${client_.user.id}/checkin-schedule`, {
      templateId: t.body.template.id, weekday: 6
    })).status).toBe(403)
  })

  it('stops being asked once the template is archived', async () => {
    const { coach, client_ } = await pair()
    const t = await withTemplate(coach, client_)
    await coach.c.del(`/api/coach/checkin-templates/${t.id}`)
    expect((await client_.c.get('/api/checkin')).body.scheduled).toHaveLength(0)
  })

  it('stops being asked once it is taken off', async () => {
    const { coach, client_ } = await pair()
    await withTemplate(coach, client_)
    expect((await coach.c.del(`/api/coach/clients/${client_.user.id}/checkin-schedule`)).status).toBe(200)
    expect((await client_.c.get('/api/checkin')).body.scheduled).toHaveLength(0)
  })

  it('is not asked at all by a coach the client did not share check-ins with', async () => {
    const { coach, client_ } = await pair(['programmes', 'workouts'])
    const t = await coach.c.post('/api/coach/checkin-templates', { title: 'Weekly', fields: FIELDS })
    await coach.c.post(`/api/coach/clients/${client_.user.id}/checkin-schedule`, {
      templateId: t.body.template.id, weekday: 6
    })
    // Scheduling succeeds — it is the coach's side of a relationship that exists — but the
    // client is not asked by somebody they did not share this with.
    expect((await client_.c.get('/api/checkin')).body.scheduled).toHaveLength(0)
  })
})

describe('a client with no coach', () => {
  it('still has a check-in to fill in', async () => {
    // The built-in set is not a row anywhere. A check-in you keep for yourself is the point.
    const alone = await signUp('Solo', 'solo@x.test')
    const r = await alone.c.get('/api/checkin')
    expect(r.body.scheduled).toHaveLength(0)
    expect(r.body.builtIn.templateId).toBeNull()
    expect(r.body.builtIn.fields.length).toBeGreaterThan(0)
  })
})

describe('answering', () => {
  it('goes through sync, and reaches the coach with its questions attached', async () => {
    const { coach, client_ } = await pair()
    const t = await withTemplate(coach, client_)

    await client_.c.post('/api/sync', {
      changes: {
        checkins: [{
          on_date: '2026-08-22', template_id: t.id,
          answers: { sleep: 4, notes: 'good week' }, submitted_at: new Date().toISOString()
        }]
      }
    })

    const seen = await coach.c.get(`/api/coach/clients/${client_.user.id}/checkins`)
    expect(seen.body.checkins).toHaveLength(1)
    expect(seen.body.checkins[0].answers).toEqual({ sleep: 4, notes: 'good week' })
    // Values under keys nobody can read are not a check-in.
    expect(seen.body.checkins[0].fields.map(f => f.label)).toEqual(['Sleep', 'Notes'])
  })

  it('is shaped against the questions on the way in, not just in the form', async () => {
    /* Found by driving a real server: the push path was storing whatever arrived. A form
     * rejects 11 out of 5 as it is typed, and a hand-made request does not go through a form —
     * so the same rule has to run here, or a waist of 4,000 cm ends up in a coach's chart. */
    const { coach, client_ } = await pair()
    const t = await withTemplate(coach, client_)
    await coach.c.post('/api/coach/checkin-templates', {
      id: t.id,
      title: 'Weekly',
      fields: [...FIELDS, { key: 'waist', type: 'measure', label: 'Waist', min: 40, max: 200 }]
    })

    await client_.c.post('/api/sync', {
      changes: {
        checkins: [{
          on_date: '2026-08-22', template_id: t.id,
          answers: { sleep: 11, waist: 4000, notes: 'felt strong' },
          submitted_at: new Date().toISOString()
        }]
      }
    })

    const [seen] = (await coach.c.get(`/api/coach/clients/${client_.user.id}/checkins`)).body.checkins
    expect(seen.answers.sleep).toBe(5)              // clamped into the scale
    expect(seen.answers).not.toHaveProperty('waist')  // outside the field's own bounds
    expect(seen.answers.notes).toBe('felt strong')
  })

  it('keeps a draft to itself', async () => {
    const { coach, client_ } = await pair()
    await withTemplate(coach, client_)
    await client_.c.post('/api/sync', {
      changes: { checkins: [{ on_date: '2026-08-22', answers: { notes: 'halfway' } }] }
    })
    expect((await coach.c.get(`/api/coach/clients/${client_.user.id}/checkins`)).body.checkins)
      .toHaveLength(0)
  })

  it('is refused to a coach the client did not share check-ins with', async () => {
    const { coach, client_ } = await pair(['programmes'])
    expect((await coach.c.get(`/api/coach/clients/${client_.user.id}/checkins`)).status).toBe(403)
  })

  it('is refused to a stranger outright', async () => {
    const { client_ } = await pair()
    const nosy = await signUp('Nosy', 'nosy@x.test')
    expect((await nosy.c.get(`/api/coach/clients/${client_.user.id}/checkins`)).status).toBe(403)
  })
})

describe('habits', () => {
  it('are proposed by a coach and become the client\'s own on acceptance', async () => {
    const { coach, client_ } = await pair()
    const p = await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      kind: 'habit', subjectId: 'hab1', payload: { title: 'Walk 10k', target: 5 }, note: 'every weekday'
    })
    expect(p.status).toBe(200)

    // Nothing has been written into the client's account yet.
    expect((await client_.c.get('/api/sync/all')).body.changes.habits).toHaveLength(0)

    const [open] = (await client_.c.get('/api/proposals')).body.proposals
    expect(open.kind).toBe('habit')
    await client_.c.post(`/api/proposals/${open.id}/accept`)

    const [h] = (await client_.c.get('/api/sync/all')).body.changes.habits
    expect(h).toMatchObject({ id: 'hab1', title: 'Walk 10k', target_per_week: 5 })
    expect(h.user_id).toBe(client_.user.id)
    expect(h.author_id).toBe(coach.user.id)
  })

  it('refuse a proposal with no title before it reaches anybody', async () => {
    const { coach, client_ } = await pair()
    const r = await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      kind: 'habit', subjectId: 'hab1', payload: { target: 3 }
    })
    expect(r.status).toBe(400)
    expect((await client_.c.get('/api/proposals')).body.proposals).toHaveLength(0)
  })

  it('are ticked through sync, and read by a coach who was given the scope', async () => {
    const { coach, client_ } = await pair()
    await client_.c.post('/api/sync', {
      changes: { habits: [{ id: 'hab1', title: 'Walk', target_per_week: 7 }] }
    })
    await client_.c.post('/api/sync', {
      changes: { habitTicks: [{ habit_id: 'hab1', on_date: new Date().toISOString().slice(0, 10) }] }
    })

    const seen = await coach.c.get(`/api/coach/clients/${client_.user.id}/habits`)
    expect(seen.body.habits).toHaveLength(1)
    expect(seen.body.ticks).toHaveLength(1)
    expect(seen.body.ticks[0].h).toBe('hab1')
    // A calendar day, not a timestamp — it is about to be a key in a grid.
    expect(seen.body.ticks[0].d).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('are refused to a coach who was not', async () => {
    const { coach, client_ } = await pair(['programmes', 'checkins'])
    expect((await coach.c.get(`/api/coach/clients/${client_.user.id}/habits`)).status).toBe(403)
    expect((await coach.c.post(`/api/coach/clients/${client_.user.id}/propose`, {
      kind: 'habit', subjectId: 'hab1', payload: { title: 'Walk' }
    })).status).toBe(403)
  })

  it('a client keeps for themselves need no coach at all', async () => {
    const alone = await signUp('Solo', 'solo@x.test')
    await alone.c.post('/api/sync', {
      changes: { habits: [{ id: 'hab1', title: 'Water', target_per_week: 7 }] }
    })
    const all = await alone.c.get('/api/sync/all')
    expect(all.body.changes.habits[0].author_id).toBe(alone.user.id)
  })
})
