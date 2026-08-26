/* Uploads, and the one endpoint that hands bytes back.
 *
 * ## Two doors, and only one of them knows who you are
 *
 * Everything under `/api/attachments` is a session: it asks who you are, checks whether this
 * upload is yours to make or this row is yours to see, and answers with rows. `/media/*` is
 * the other door and it has no session at all — it takes a signature, and the signature *is*
 * the permission, minted minutes earlier by a route on the first door that had already decided.
 *
 * That split is what lets nginx serve a 60 MB video without Node touching a byte of it, and it
 * is why a leaked media URL is worth so little: it names one object and stops working shortly.
 *
 * ## The upload is a raw body, not a form
 *
 * No multipart, no filename, no fields. A multipart form's only contribution here would be a
 * filename this app has already decided never to use — `packages/storage/src/keys.js` builds
 * every key from the owner, the row id and the clock — plus a parser to keep hardened. So the
 * bytes are the body and the context is in the query string, which is also what makes the
 * request streamable: the first bytes off the wire are the ones that decide what the file is.
 *
 * The declared `Content-Type` decides one thing only — whether this route will read the body at
 * all — and nothing about what the file *is*. That is sniffed from the leading bytes; see
 * `packages/storage/src/sniff.js` for why believing the header would be a security bug rather
 * than a convenience.
 *
 * ## Order of operations, and what each failure leaves behind
 *
 *   1. permission, quota, declared length      → nothing written
 *   2. sniff the head, decide the type         → nothing written
 *   3. reserve the row                         → a row with no bytes; the sweeper's problem
 *   4. stream to storage                       → bytes with a row that names them
 *   5. finish the row                          → visible
 *
 * A failure at 4 leaves exactly what step 3 wrote, which is a row `abandoned()` will find. A
 * failure between 4 and 5 leaves the same thing. There is no ordering here that leaves bytes
 * nothing knows about, which is the property the whole design is built around.
 */
import { Readable } from 'node:stream'
import { createReadStream } from 'node:fs'
import crypto from 'node:crypto'
import {
  buildKey, sniff, kindFor, mimeForKey, verify, supportedTypes, SNIFF_BYTES
} from '@gymbuddy/storage'
import {
  reserve, finish, remove, byId, forWorkout, progressFor, usageFor, publicView
} from '@gymbuddy/db/attachments.js'
import { requireScope, linkById } from '@gymbuddy/db/coaching.js'
import { db } from '@gymbuddy/db'
import { requireUser } from '../session.js'
import { requireCoach } from '../entitlement.js'
import { config } from '../config.js'
import { storage, withUrl, withUrls, limitFor } from '../media.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

/** ISO day, or throw. A progress photo is filed under a date, and "today" is the client's. */
const asDate = v => {
  const s = String(v || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad('a date is required')
  return s
}

/* ------------------------------------------------------------- reading ---- */

/**
 * Whether `reader` may see `row`, and nothing about whether it exists.
 *
 * Three subjects, three different answers, and each one defers to a rule that already exists
 * rather than inventing a second copy of it. A 403 rather than a 404 for somebody else's
 * attachment is deliberate: ids are uuids, so there is nothing to enumerate, and telling a
 * coach "not shared with you" is the true answer where "no such file" is not.
 */
async function mayRead(reader, row) {
  if (!row) throw bad('no such attachment', 404)
  if (row.owner_id === reader.id) return row

  if (row.subject === 'form_check') {
    await requireScope(reader.id, row.owner_id, 'workouts')
    return row
  }
  if (row.subject === 'progress') {
    await requireScope(reader.id, row.owner_id, 'photos')
    return row
  }
  // A message attachment is readable by the two people in the conversation, which is the same
  // question `readThread` asks and is asked here of the link rather than of the message.
  const [msg] = await db()`select link_id from messages where id = ${row.message_id}`
  const link = msg && await linkById(msg.link_id)
  if (link && (link.coach_id === reader.id || link.client_id === reader.id)) return row
  throw bad('not yours', 403)
}

export default async function mediaRoutes(app) {
  /* The upload body arrives as a stream rather than a parsed value.
   *
   * Handing the payload straight back is what keeps a 60 MB video out of this process's heap:
   * every parser Fastify ships buffers the whole body first, and letting one video through
   * would mean raising `bodyLimit` to sixty megabytes for every route in the app.
   *
   * Registered for the types a real client sends. `application/octet-stream` is the contract —
   * it is the one that means "these are bytes", which is exactly how much any of this is
   * trusted — and the storable types are here beside it so that a caller labelling its file
   * honestly is not refused for it. None of them is *believed*: a parser registration decides
   * whether a body is read as a stream, and the type is then sniffed from the bytes
   * regardless. A `text/html` upload is refused right here, before a handler runs.
   */
  for (const type of ['application/octet-stream', ...supportedTypes()]) {
    app.addContentTypeParser(type, (req, payload, done) => done(null, payload))
  }

  /* ------------------------------------------------------------ upload ---- */

  app.post('/api/attachments', async (req, reply) => {
    const user = await requireUser(req)
    const subject = String(req.query?.subject || '')
    if (!['form_check', 'progress', 'message'].includes(subject)) {
      throw bad('unknown attachment subject')
    }

    // Context first, so a request that was never going to be storable is refused before a
    // single byte is read off the wire.
    const context = {}
    if (subject === 'form_check') {
      const workoutId = String(req.query?.workout || '')
      const exerciseId = String(req.query?.exercise || '')
      if (!workoutId || !exerciseId) throw bad('a workout and an exercise are required')
      // Their own session, or none. A form check filed against somebody else's workout id
      // would be a row two different permission rules disagree about.
      const [w] = await db()`
        select id from workouts where id = ${workoutId} and user_id = ${user.id}
          and deleted_at is null`
      if (!w) throw bad('no such workout', 404)
      Object.assign(context, { workoutId, exerciseId })
    } else if (subject === 'progress') {
      context.onDate = asDate(req.query?.date)
    } else {
      const messageId = String(req.query?.message || '')
      const [msg] = await db()`select * from messages where id = ${messageId}`
        .catch(() => [])                       // a malformed uuid is a 404, not a 500
      if (!msg || msg.sender_id !== user.id) throw bad('no such message', 404)
      // Attaching to a message is authoring, so it is gated exactly where writing one is —
      // and on the same side. A client attaching a video for their coach is never blocked.
      const link = await linkById(msg.link_id)
      if (link?.coach_id === user.id) await requireCoach(user.id, 'message')
      context.messageId = messageId
    }

    /* The quota, read before the upload rather than after.
     *
     * An account already at its ceiling is refused here, which costs one query; refusing after
     * the bytes have arrived would mean paying the bandwidth to say no. The check is against
     * what is already stored, so a single upload may cross the line by at most one file — the
     * alternative is holding a reservation for bytes nobody has sent yet, and an accounting
     * scheme that can leak is worse than a ceiling that is soft by one video.
     */
    if (config.media.quotaBytes) {
      const { bytes } = await usageFor(user.id)
      if (bytes >= config.media.quotaBytes) throw bad('media storage is full', 413)
    }

    // The declared length, when there is one. Not trusted for anything except saying no early:
    // a client that lies low still meets the real ceiling while streaming.
    const declared = Number(req.headers['content-length'] || 0)

    const source = req.body
    if (!source || typeof source[Symbol.asyncIterator] !== 'function') {
      throw bad('send the file as the request body, with Content-Type: application/octet-stream')
    }

    /* Read enough of the head to know what this is, keeping the iterator so the rest of the
     * stream can follow it into storage without being buffered. */
    const it = source[Symbol.asyncIterator]()
    const head = []
    let got = 0
    while (got < SNIFF_BYTES) {
      const { value, done } = await it.next()
      if (done) break
      head.push(value)
      got += value.length
    }
    const headBuf = Buffer.concat(head)
    const mime = sniff(headBuf)
    const kind = kindFor(mime)
    if (!kind) throw bad('that kind of file is not supported', 415)

    const allowed = { form_check: ['video', 'photo'], progress: ['photo'], message: ['photo', 'video', 'audio'] }
    if (!allowed[subject].includes(kind)) {
      throw bad(`a ${kind} cannot be attached to that`, 415)
    }

    const limit = limitFor(kind)
    if (declared && declared > limit) throw bad(`too large: the limit for a ${kind} is ${limit} bytes`, 413)

    const id = crypto.randomUUID()
    const storageKey = buildKey({ ownerId: user.id, id, mime })
    await reserve({ id, ownerId: user.id, subject, kind, mime, storageKey, ...context })

    /* The body, replayed from the head and then continued, counting as it goes.
     *
     * Throwing mid-stream is what enforces the limit on a client that under-declared: the
     * driver's temporary file is removed and the reserved row is left for the sweeper, which
     * is the same outcome as any other interrupted upload.
     */
    let bytes = 0
    async function* body() {
      if (headBuf.length) { bytes += headBuf.length; yield headBuf }
      while (true) {
        const { value, done } = await it.next()
        if (done) return
        bytes += value.length
        if (bytes > limit) throw bad(`too large: the limit for a ${kind} is ${limit} bytes`, 413)
        yield value
      }
    }

    await storage().put({ key: storageKey, body: Readable.from(body()), contentType: mime })
    if (!bytes) throw bad('empty upload')

    const row = await finish({ id, bytes })
    reply.code(201)
    return { attachment: withUrl(row) }
  })

  /* -------------------------------------------------------------- rows ---- */

  app.get('/api/attachments', async req => {
    const user = await requireUser(req)
    const workoutId = String(req.query?.workout || '')
    if (!workoutId) throw bad('a workout is required')
    return { attachments: withUrls(await forWorkout(user.id, workoutId)) }
  })

  app.get('/api/attachments/progress', async req => {
    const user = await requireUser(req)
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 60))
    return { attachments: withUrls(await progressFor(user.id, { limit })) }
  })

  app.get('/api/attachments/usage', async req => {
    const user = await requireUser(req)
    const { bytes, files } = await usageFor(user.id)
    return { bytes, files, quota: config.media.quotaBytes || null }
  })

  /** One attachment, for a reader who may or may not be its owner. */
  app.get('/api/attachments/:id', async req => {
    const user = await requireUser(req)
    const row = await mayRead(user, await byId(req.params.id).catch(() => null))
    return { attachment: withUrl(row) }
  })

  app.patch('/api/attachments/:id', async req => {
    const user = await requireUser(req)
    const caption = req.body?.caption == null ? null : String(req.body.caption).trim().slice(0, 500)
    const [row] = await db()`
      update attachments set caption = ${caption}
      where id = ${req.params.id} and owner_id = ${user.id} and deleted_at is null
      returning *`.catch(() => [])
    if (!row) throw bad('no such attachment', 404)
    return { attachment: publicView(row) }
  })

  /**
   * Delete: the row leaves every screen now, the bytes leave when the sweeper runs.
   *
   * Only the owner, and never the coach. A coach who could delete a client's form check could
   * delete evidence of what they told them to do.
   */
  app.delete('/api/attachments/:id', async req => {
    const user = await requireUser(req)
    const row = await remove({ id: req.params.id, ownerId: user.id }).catch(() => null)
    if (!row) throw bad('no such attachment', 404)
    return { ok: true }
  })

  /* ------------------------------------------------------- coach reads ---- */

  /* These live here rather than in `routes/coaching.js` because what they enforce is the
   * attachment rule — the scope each subject rides on — and splitting that across two files is
   * how the two copies start to disagree. The permission itself is `requireScope`, unchanged. */

  app.get('/api/coach/clients/:id/attachments', async req => {
    const coach = await requireUser(req)
    const workoutId = String(req.query?.workout || '')
    if (!workoutId) throw bad('a workout is required')
    await requireScope(coach.id, req.params.id, 'workouts')
    return { attachments: withUrls(await forWorkout(req.params.id, workoutId)) }
  })

  app.get('/api/coach/clients/:id/progress', async req => {
    const coach = await requireUser(req)
    await requireScope(coach.id, req.params.id, 'photos')
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 60))
    return { attachments: withUrls(await progressFor(req.params.id, { limit })) }
  })

  /* ------------------------------------------------------------- bytes ---- */

  /**
   * The unauthenticated door. A valid signature over this key, unexpired, or nothing.
   *
   * No cookie is read and no row is loaded. Loading one would mean a database round trip per
   * range request — a video seeking through a long clip issues a great many — and it would buy
   * nothing: the signature already encodes the decision, and an attachment deleted since is
   * bytes the sweeper is about to remove.
   */
  app.get('/media/*', async (req, reply) => {
    const key = req.params['*']
    const ok = verify(key, {
      secret: config.secret, expiresAt: req.query?.e, sig: req.query?.s
    })
    if (!ok) throw bad('expired or invalid link', 403)

    const mime = mimeForKey(key)
    if (!mime) throw bad('expired or invalid link', 403)

    /* Never let a browser second-guess the type. These bytes came from a stranger and are
     * served from the app's own origin; `nosniff` is what keeps "stored file" from becoming
     * "script on your domain" if the type above is ever wrong. */
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Type', mime)

    if (config.media.accel) {
      // nginx takes it from here, including ranges. The path is the internal location in
      // infra/web/nginx.conf, not a filesystem path — see the `internal` block there.
      reply.header('X-Accel-Redirect', `/_media/${key}`)
      return reply.send('')
    }

    const store = storage()
    if (typeof store.internalPath !== 'function') {
      throw Object.assign(new Error('this storage driver serves its own bytes'), { status: 501 })
    }
    const info = await store.stat(key)
    if (!info) throw bad('no such file', 404)

    const path = store.internalPath(key)
    reply.header('Accept-Ranges', 'bytes')

    /* Ranges, because a video element asks for them and Safari will not play a clip served
     * without them. nginx does this properly in production; this is the dev and test path. */
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (range) {
      const last = info.bytes - 1
      const start = range[1] ? Number(range[1]) : Math.max(0, info.bytes - Number(range[2] || 0))
      const end = range[1] ? (range[2] ? Math.min(Number(range[2]), last) : last) : last
      if (!(start <= end && start >= 0 && end <= last)) {
        reply.header('Content-Range', `bytes */${info.bytes}`)
        throw bad('range not satisfiable', 416)
      }
      reply.code(206)
      reply.header('Content-Range', `bytes ${start}-${end}/${info.bytes}`)
      reply.header('Content-Length', end - start + 1)
      return reply.send(createReadStream(path, { start, end }))
    }

    reply.header('Content-Length', info.bytes)
    return reply.send(createReadStream(path))
  })
}
