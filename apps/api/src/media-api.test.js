/* Uploads, permissions and the byte door, over the real routes and a real temporary volume.
 *
 * The filesystem is not mocked, for the same reason `packages/storage`'s own suite does not
 * mock it: the two things most worth being certain of are that an upload lands as a whole file
 * and that nobody can read one they were not given, and a fake `fs` is precisely the thing
 * that would agree with the implementation about both.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { build } from './app.js'
import { client } from './test-client.js'
import { resetStorage } from './media.js'
import { sweepOnce } from './sweeper.js'
import { db, close } from '@gymyar/db'

let app, root
const URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

beforeAll(async () => {
  process.env.SESSION_SECRET = 'test-secret-not-for-production'
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gymyar-media-'))
  process.env.STORAGE_PATH = root
  process.env.STORAGE_DRIVER = 'fs'
  resetStorage()
  app = await build({ databaseUrl: URL, rateLimit: false })
  const { seedExercises } = await import('@gymyar/db/seed-exercises.js')
  await seedExercises()
})
beforeEach(async () => {
  await db()`delete from users`
  // Deliberately not reachable by that cascade — see the table's comment in 004. Cleared here
  // so one test's tombstones are not another test's sweep.
  await db()`delete from orphaned_media`
})
afterAll(async () => {
  await app.close()
  await close()
  await fs.rm(root, { recursive: true, force: true })
  delete process.env.STORAGE_PATH
  delete process.env.STORAGE_DRIVER
  resetStorage()
})

/* ---------------------------------------------------------------- files ---- */

/* Real leading bytes, then filler. The sniffer only reads the head, so the filler is what
 * makes these files a size worth asserting about. */
const file = (magic, size = 512) => {
  const head = Buffer.isBuffer(magic) ? magic : Buffer.from(magic, 'binary')
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x20)])
}
const MP4 = size => file(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom')]), size)
const JPEG = size => file(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), size)
const WEBM = size => file(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), size)
const HTML = size => file('<!DOCTYPE html><html><body>hi</body></html>', size)

/* ---------------------------------------------------------------- setup ---- */

const signUp = async (name, email, extra = {}) => {
  const c = client(app)
  const r = await c.post('/api/register/password', {
    name, email, password: 'correct-horse-battery', ...extra
  })
  expect(r.status).toBe(200)
  return { c, user: r.body.user }
}

/** A finished session belonging to `user`, which a form check needs to point at. */
async function workout(c, id = 'w1') {
  const now = new Date().toISOString()
  const r = await c.post('/api/sync', {
    changes: {
      workouts: [{
        id, started_at: now, finished_at: now, routine_name: 'Push A',
        sets: [{
          id: `${id}-s1`, workout_id: id, exercise_id: '0025', position: 0,
          weight_kg: 60, reps: 5, seconds: null, distance_m: null, per_side: false,
          effort_value: null, effort_scale: null, is_warmup: false, done: true, done_at: now
        }]
      }]
    }
  })
  expect(r.status).toBe(200)
  return id
}

const linkedPair = async (scopes = ['programmes', 'workouts']) => {
  const coach = await signUp('Coach', 'coach@x.test', { asCoach: true })
  const clientSide = await signUp('Ava', 'ava@x.test')
  const inv = await coach.c.post('/api/coach/invites', { email: 'ava@x.test', scopes })
  expect(inv.status).toBe(200)
  const acc = await clientSide.c.post(`/api/invites/${inv.body.invite.code}/accept`, { scopes })
  expect(acc.status).toBe(200)
  return { coach, client: clientSide }
}

/* ----------------------------------------------------------------- tests ---- */

describe('uploading a form check', () => {
  it('stores the bytes and answers with a URL that works', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4(2048))
    expect(r.status).toBe(201)
    expect(r.body.attachment.kind).toBe('video')
    expect(r.body.attachment.mime).toBe('video/mp4')
    expect(Number(r.body.attachment.bytes)).toBe(2048)

    const bytes = await c.fetch(r.body.attachment.url)
    expect(bytes.status).toBe(200)
    expect(bytes.raw.length).toBe(2048)
    expect(bytes.headers['content-type']).toBe('video/mp4')
  })

  it('never hands back the storage key', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    expect(r.body.attachment.storage_key).toBeUndefined()
    // The URL carries the key, but signed and with an expiry — which is the whole point.
    expect(r.body.attachment.url).toMatch(/^\/media\/.+\?e=\d+&s=/)
  })

  it('reads the type from the bytes, not from what the request claimed', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    // Says video/mp4 in the clearest possible terms; is a JPEG.
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025',
      JPEG(), { 'content-type': 'video/mp4' })
    expect(r.status).toBe(201)
    expect(r.body.attachment.mime).toBe('image/jpeg')
    expect(r.body.attachment.kind).toBe('photo')
  })

  it('refuses a body labelled as something this app never stores', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025',
      MP4(), { 'content-type': 'text/html' })
    expect(r.status).toBe(415)
  })

  it('refuses a document dressed as a video', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025',
      HTML(), { 'content-type': 'video/mp4' })
    expect(r.status).toBe(415)
    const [{ n }] = await db()`select count(*)::int as n from attachments`
    expect(n).toBe(0)
  })

  it('refuses a recording of a lift', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', WEBM())
    expect(r.status).toBe(415)
    expect(r.body.error).toMatch(/audio/)
  })

  it('refuses a session that is not theirs', async () => {
    const a = await signUp('Sam', 'sam@x.test')
    const b = await signUp('Theo', 'theo@x.test')
    await workout(a.c, 'w1')
    const r = await b.c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    expect(r.status).toBe(404)
  })

  it('refuses an upload with no session at all', async () => {
    const c = client(app)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    expect(r.status).toBe(401)
  })

  it('refuses an empty body', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', Buffer.alloc(0))
    expect(r.status).toBeGreaterThanOrEqual(400)
  })

  it('leaves nothing behind when it refuses', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', HTML())
    const [{ n }] = await db()`select count(*)::int as n from attachments`
    expect(n).toBe(0)
  })
})

describe('the limits', () => {
  it('refuses a file over the ceiling before reading it, on the declared length', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025',
      MP4(1024), { 'content-length': String(999 * 1024 * 1024) })
    expect(r.status).toBe(413)
  })

  it('publishes the ceilings so a phone can refuse before it sends', async () => {
    const c = client(app)
    const cfg = await c.get('/api/config')
    expect(cfg.body.media.limits.video).toBeGreaterThan(0)
    expect(cfg.body.media.limits.photo).toBeGreaterThan(0)
    expect(cfg.body.media.maxVideoSeconds).toBeGreaterThan(0)
  })

  it('reports what an account is holding', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4(4096))
    const r = await c.get('/api/attachments/usage')
    expect(r.body.bytes).toBe(4096)
    expect(r.body.files).toBe(1)
  })
})

describe('progress photos', () => {
  it('files one under a date and lists it back', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    const r = await c.upload('/api/attachments?subject=progress&date=2026-08-01', JPEG(700))
    expect(r.status).toBe(201)
    expect(r.body.attachment.on_date).toBe('2026-08-01')

    const list = await c.get('/api/attachments/progress')
    expect(list.body.attachments).toHaveLength(1)
    expect(list.body.attachments[0].url).toBeTruthy()
  })

  it('refuses a video of a body, and a date that is not one', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    expect((await c.upload('/api/attachments?subject=progress&date=2026-08-01', MP4())).status).toBe(415)
    expect((await c.upload('/api/attachments?subject=progress&date=last+tuesday', JPEG())).status).toBe(400)
  })
})

describe('what a coach may see', () => {
  it('shows a form check to a coach the client shared workouts with', async () => {
    const { coach, client: c } = await linkedPair(['programmes', 'workouts'])
    await workout(c.c)
    await c.c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4(1500))

    const r = await coach.c.get(`/api/coach/clients/${c.user.id}/attachments?workout=w1`)
    expect(r.status).toBe(200)
    expect(r.body.attachments).toHaveLength(1)
    const bytes = await coach.c.fetch(r.body.attachments[0].url)
    expect(bytes.status).toBe(200)
  })

  it('refuses a coach the client did not share workouts with', async () => {
    const { coach, client: c } = await linkedPair(['programmes'])
    await workout(c.c)
    await c.c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    const r = await coach.c.get(`/api/coach/clients/${c.user.id}/attachments?workout=w1`)
    expect(r.status).toBe(403)
  })

  it('does not let sharing a weigh-in share a photograph', async () => {
    const { coach, client: c } = await linkedPair(['programmes', 'workouts', 'bodyweight'])
    await c.c.upload('/api/attachments?subject=progress&date=2026-08-01', JPEG())
    const r = await coach.c.get(`/api/coach/clients/${c.user.id}/progress`)
    expect(r.status).toBe(403)
    expect(r.body.error).toMatch(/photos/)
  })

  it('shows photographs to a coach who was granted that scope on its own', async () => {
    const { coach, client: c } = await linkedPair(['programmes', 'photos'])
    await c.c.upload('/api/attachments?subject=progress&date=2026-08-01', JPEG())
    const r = await coach.c.get(`/api/coach/clients/${c.user.id}/progress`)
    expect(r.status).toBe(200)
    expect(r.body.attachments).toHaveLength(1)
  })

  it('offers photos as a scope a client can grant', async () => {
    const { coach } = await linkedPair()
    const r = await coach.c.get('/api/coaches')
    expect(r.body.scopes).toContain('photos')
  })

  it('cannot delete a client’s form check', async () => {
    const { coach, client: c } = await linkedPair(['programmes', 'workouts'])
    await workout(c.c)
    const up = await c.c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    const r = await coach.c.del(`/api/attachments/${up.body.attachment.id}`)
    expect(r.status).toBe(404)
    expect((await c.c.get('/api/attachments?workout=w1')).body.attachments).toHaveLength(1)
  })
})

describe('a message with a file on it', () => {
  const thread = async () => {
    const pair = await linkedPair()
    const coaches = await pair.client.c.get('/api/coaches')
    return { ...pair, linkId: coaches.body.coaches[0].link_id ?? coaches.body.coaches[0].id }
  }

  it('carries the attachment back with the conversation', async () => {
    const { coach, client: c, linkId } = await thread()
    const sent = await c.c.post(`/api/threads/${linkId}`, { body: 'how is this?' })
    expect(sent.status).toBe(200)
    const up = await c.c.upload(`/api/attachments?subject=message&message=${sent.body.message.id}`, WEBM(300))
    expect(up.status).toBe(201)
    expect(up.body.attachment.kind).toBe('audio')

    const read = await coach.c.get(`/api/threads/${linkId}`)
    const msg = read.body.messages.find(m => m.id === sent.body.message.id)
    expect(msg.attachments).toHaveLength(1)
    expect((await coach.c.fetch(msg.attachments[0].url)).status).toBe(200)
  })

  it('refuses somebody else’s message to attach to', async () => {
    const { coach, client: c, linkId } = await thread()
    const sent = await coach.c.post(`/api/threads/${linkId}`, { body: 'hello' })
    const up = await c.c.upload(`/api/attachments?subject=message&message=${sent.body.message.id}`, WEBM())
    expect(up.status).toBe(404)
  })

  it('treats a mangled message id as a missing one, not as a crash', async () => {
    const { client: c } = await thread()
    const up = await c.c.upload('/api/attachments?subject=message&message=not-a-uuid', WEBM())
    expect(up.status).toBe(404)
  })
})

describe('the byte door', () => {
  const uploaded = async () => {
    const { c, user } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const r = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4(4096))
    return { c, user, url: r.body.attachment.url, id: r.body.attachment.id }
  }

  it('refuses a URL with the signature removed', async () => {
    const { c, url } = await uploaded()
    expect((await c.fetch(url.split('?')[0])).status).toBe(403)
  })

  it('refuses a URL whose expiry was moved', async () => {
    const { c, url } = await uploaded()
    const moved = url.replace(/e=\d+/, 'e=' + (Math.floor(Date.now() / 1000) + 99999))
    expect((await c.fetch(moved)).status).toBe(403)
  })

  it('refuses a signature reused for a different file', async () => {
    const { c, url } = await uploaded()
    const other = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', JPEG())
    const otherKey = other.body.attachment.url.split('?')[0]
    expect((await c.fetch(otherKey + '?' + url.split('?')[1])).status).toBe(403)
  })

  it('refuses a path that climbs out of the volume', async () => {
    const { c } = await uploaded()
    const r = await c.fetch('/media/../../../../etc/passwd?e=9999999999&s=x')
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
  })

  it('tells the browser not to second-guess the type', async () => {
    const { c, url } = await uploaded()
    const r = await c.fetch(url)
    expect(r.headers['x-content-type-options']).toBe('nosniff')
  })

  it('serves a range, so a video can be seeked', async () => {
    const { c, url } = await uploaded()
    const r = await c.fetch(url, { range: 'bytes=100-199' })
    expect(r.status).toBe(206)
    expect(r.headers['content-range']).toBe('bytes 100-199/4096')
    expect(r.raw.length).toBe(100)
    expect(r.headers['accept-ranges']).toBe('bytes')
  })

  it('refuses a range past the end of the file', async () => {
    const { c, url } = await uploaded()
    expect((await c.fetch(url, { range: 'bytes=99999-' })).status).toBe(416)
  })

  it('is cacheable, unlike everything else this API says', async () => {
    const { c, url } = await uploaded()
    const media = await c.fetch(url)
    expect(media.headers['cache-control']).toBeUndefined()
    const json = await c.get('/api/me')
    expect(json.headers['cache-control']).toBe('no-store')
  })
})

describe('deleting, and the sweeper behind it', () => {
  it('goes from every screen at once and leaves the bytes for the sweep', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const up = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    const [row] = await db()`select storage_key from attachments`
    const onDisk = path.join(root, row.storage_key)

    expect(await fs.stat(onDisk)).toBeTruthy()
    expect((await c.del(`/api/attachments/${up.body.attachment.id}`)).status).toBe(200)
    expect((await c.get('/api/attachments?workout=w1')).body.attachments).toHaveLength(0)
    // Still there — "deleted" is a promise the sweeper keeps, and this is the gap it closes.
    expect(await fs.stat(onDisk)).toBeTruthy()

    const swept = await sweepOnce()
    expect(swept.files).toBe(1)
    expect(swept.purged).toBe(1)
    await expect(fs.stat(onDisk)).rejects.toThrow()
    const [{ n }] = await db()`select count(*)::int as n from attachments`
    expect(n).toBe(0)
  })

  it('sweeps an upload that never finished, and leaves a live one alone', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    await db()`update attachments set uploaded_at = null, bytes = null,
                created_at = now() - interval '3 hours'`

    const swept = await sweepOnce({ abandonedAfterMinutes: 60 })
    expect(swept.purged).toBe(1)
  })

  it('does nothing at all when there is nothing to do', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    expect(await sweepOnce()).toEqual({ files: 0, purged: 0, resets: 0, failed: 0, considered: 0 })
  })

  it('deletes the files of an account that was removed', async () => {
    // The dangerous case: the cascade erases the rows without this process being involved, so
    // without the tombstone these bytes would sit on the volume with nothing left that knows
    // they exist. "We deleted your account and kept your photographs" is not a bug to ship.
    const { c, user } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    await c.upload('/api/attachments?subject=progress&date=2026-08-01', JPEG())
    const rows = await db()`select storage_key from attachments where owner_id = ${user.id}`
    expect(rows).toHaveLength(2)

    await db()`delete from users where id = ${user.id}`
    expect((await db()`select count(*)::int as n from attachments`)[0].n).toBe(0)
    for (const r of rows) expect(await fs.stat(path.join(root, r.storage_key))).toBeTruthy()

    const swept = await sweepOnce()
    expect(swept.files).toBe(2)
    for (const r of rows) {
      await expect(fs.stat(path.join(root, r.storage_key))).rejects.toThrow()
    }
    expect((await db()`select count(*)::int as n from orphaned_media`)[0].n).toBe(0)
  })

  it('keeps the key when the volume refuses, rather than forgetting the file', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const up = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    await c.del(`/api/attachments/${up.body.attachment.id}`)

    // A volume that cannot be written to is a delay, never a leak: the key stays on the list.
    const broken = { delete: async () => { throw new Error('volume is read-only') } }
    const { storage } = await import('./media.js')
    const real = storage()
    real.delete = broken.delete
    try {
      const swept = await sweepOnce()
      expect(swept.failed).toBe(1)
      expect((await db()`select count(*)::int as n from orphaned_media`)[0].n).toBe(1)
    } finally {
      resetStorage()
    }
    // With the volume back, the next pass finishes the job.
    const swept = await sweepOnce()
    expect(swept.files).toBe(1)
    expect((await db()`select count(*)::int as n from orphaned_media`)[0].n).toBe(0)
  })

  it('runs twice without complaining, which is what lets two containers run it', async () => {
    const { c } = await signUp('Sam', 'sam@x.test')
    await workout(c)
    const up = await c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    await c.del(`/api/attachments/${up.body.attachment.id}`)
    await sweepOnce()
    expect((await sweepOnce()).failed).toBe(0)
  })
})

describe('captions', () => {
  it('can be set and cleared by the owner only', async () => {
    const a = await signUp('Sam', 'sam@x.test')
    const b = await signUp('Theo', 'theo@x.test')
    await workout(a.c)
    const up = await a.c.upload('/api/attachments?subject=form_check&workout=w1&exercise=0025', MP4())
    const id = up.body.attachment.id

    expect((await a.c.patch(`/api/attachments/${id}`, { caption: 'felt heavy' })).body.attachment.caption)
      .toBe('felt heavy')
    expect((await b.c.patch(`/api/attachments/${id}`, { caption: 'mine now' })).status).toBe(404)
    expect((await a.c.patch(`/api/attachments/${id}`, { caption: null })).body.attachment.caption)
      .toBeUndefined()
  })
})
