/* The iPhone's way in — docs/WEARABLES.md M3.
 *
 * There is no native iOS build to read HealthKit from, and RELEASING.md explains at length why
 * there is not going to be one. What an iPhone does have is Shortcuts: a personal automation on
 * *when a workout ends*, and a `Get Contents of URL` step. So the phone pushes the session here
 * rather than us reading it off the phone — no Developer Program, no Mac, no store review, and
 * no dependency anybody can switch off.
 *
 * Two kinds of caller, and they authenticate differently on purpose:
 *
 *   /api/health/tokens      the person, in the app, with a session cookie. Mints and revokes.
 *   /api/health/workout     the shortcut, months later, with a bearer token and no cookie jar.
 *
 * PWA only, necessarily. The native builds have no server to POST to and must not grow one —
 * MOBILE.md promises state never leaves the device, and that promise is the product.
 */
import { healthActivity } from '@gymyar/domain'
import {
  issueHealthToken, healthTokensOf, revokeHealthToken,
  userForHealthToken, recordHealthWorkout
} from '@gymyar/db/health.js'
import { requireUser } from '../session.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

/* A number, or null. Shortcuts sends everything as text — a "Number" magic variable arrives as
 * "138" and an empty one as "" — so a field that is absent, blank or unparseable is the normal
 * case here rather than a client bug, and none of those may become 0. */
const num = v => {
  if (v == null || v === '') return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

/* An instant this endpoint will believe: ISO 8601, with the offset spelled out.
 *
 * Matched before it is parsed, and both halves of that matter.
 *
 * `Date.parse` is not a validator. It takes "03/09/2026" happily and reads it the American way,
 * so a September session from a phone set to write dates the way most of the world does lands
 * in March — no error, no clue, one row on the wrong day. Anything that is not ISO is refused
 * rather than guessed at.
 *
 * And the offset is required, not optional. An ISO date-time without one is local time by the
 * spec, which means *the server's* local time — so a 21:00 session in Tehran, pushed to an
 * instance running in UTC, is filed at 21:00 UTC and lands on the day after the one the person
 * trained on. Tehran is +03:30 and this project's users are in it. Shortcuts can emit the
 * offset with one setting in its Format Date step, and the setup guide says which. */
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/
const instant = v => {
  const str = String(v ?? '').trim()
  if (!ISO.test(str)) return null
  const t = Date.parse(str.replace(' ', 'T'))
  return isFinite(t) ? new Date(t) : null
}

const bpm = v => {
  const n = num(v)
  return n != null && n >= 25 && n <= 240 ? Math.round(n) : null
}

/**
 * The body a shortcut sends, into the session `recordHealthWorkout` stores.
 *
 * Everything except the id and the start is optional, because every one of these is a step
 * somebody has to add to a shortcut by hand and the guide is shorter if the minimum is small. A
 * session with nothing but a start still says "you trained", which is the thing the app cannot
 * otherwise know.
 */
function sessionFrom(body) {
  const externalId = String(body?.uuid ?? body?.id ?? '').trim()
  if (!externalId) throw bad('uuid is required — it is what stops a re-run adding a second copy')
  if (externalId.length > 200) throw bad('uuid is too long')

  const startedAt = instant(body?.start)
  if (!startedAt) throw bad('start must be an ISO 8601 date with a time zone offset — see the setup guide')
  const finishedAt = instant(body?.end)
  if (finishedAt && finishedAt < startedAt) throw bad('end is before start')

  const act = healthActivity(body?.type)
  const minutes = num(body?.minutes) ??
    (finishedAt ? (finishedAt - startedAt) / 60000 : null)
  const km = num(body?.distanceKm)

  /* One set on the activity's exercise, or none at all.
   *
   * `exerciseId` is null for everything the library has no honest match for — strength
   * training, walking, yoga — and inventing a custom exercise from here is not possible: a
   * custom exercise belongs to the profile's own list, and this endpoint writes rows rather
   * than state. So those sessions are recorded with their name, their times and their heart
   * rate and no sets, which is exactly what HealthKit knew about them anyway. */
  const sets = act.exerciseId && (minutes > 0 || km > 0)
    ? [{
      exerciseId: act.exerciseId,
      seconds: minutes > 0 ? Math.round(minutes * 60) : null,
      distanceM: km > 0 ? Math.round(km * 1000) : null
    }]
    : []

  /* The four numbers 012 already stores. All or nothing, as the constraint requires — a
   * shortcut that sends an average and no range would otherwise fail the whole insert on a
   * check violation, which is a 500 for what is really a half-filled form. */
  const avg = bpm(body?.hrAvg), min = bpm(body?.hrMin), max = bpm(body?.hrMax)
  const n = num(body?.hrSamples)
  const hr = avg != null && min != null && max != null && n > 0 && min <= avg && avg <= max
    ? { avg, min, max, n: Math.round(n) }
    : null

  return { externalId, name: act.title, startedAt, finishedAt, sets, hr }
}

/* The bearer token, from the one header Shortcuts can set without ceremony. */
function bearer(req) {
  const h = req.headers?.authorization || ''
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim())
  return m ? m[1].trim() : null
}

export default async function healthRoutes(app) {
  /* ------------------------------------------------------- the pairing ---- */

  app.get('/api/health/tokens', async req => {
    const user = await requireUser(req)
    return { tokens: await healthTokensOf(user.id) }
  })

  /* The only time the token exists in the clear. Said plainly in the response so the screen
   * that shows it can say so too — somebody who closes that sheet without copying it has to
   * make another one, and being told that afterwards is no use. */
  app.post('/api/health/tokens', async req => {
    const user = await requireUser(req)
    const live = await healthTokensOf(user.id)
    // Not a rate limit — a ceiling on clutter. Nobody has eleven phones, and an account with a
    // hundred live tokens is one where "revoke the one that leaked" has stopped being possible.
    if (live.length >= 10) throw bad('that is ten live tokens already — revoke one first', 409)
    const { id, createdAt, token } = await issueHealthToken(user.id)
    return { token: { id, createdAt }, secret: token, shownOnce: true }
  })

  app.delete('/api/health/tokens/:id', async req => {
    const user = await requireUser(req)
    const gone = await revokeHealthToken(user.id, req.params.id)
    if (!gone) throw bad('no such token', 404)
    return { ok: true }
  })

  /* ------------------------------------------------------- the session ---- */

  /**
   * What the shortcut calls, once per finished workout, possibly more than once.
   *
   * No session cookie is consulted and none would help: this runs on a locked phone months
   * after it was set up. The token is the whole of the authentication, which is why it is
   * revocable per device and why `last_used_at` is written on every accepted call — an
   * automation that has quietly stopped firing is otherwise indistinguishable from one that
   * has simply had nothing to report.
   */
  app.post('/api/health/workout', async (req, reply) => {
    const token = bearer(req)
    if (!token) throw bad('missing bearer token', 401)
    const userId = await userForHealthToken(token)
    if (!userId) throw bad('that token is not valid', 401)

    const session = sessionFrom(req.body || {})
    const { id, created } = await recordHealthWorkout(userId, session)
    // 201 the first time and 200 after it, so a shortcut that wants to can tell the difference
    // — and so that a person testing it by pressing Run twice sees that the second one landed
    // somewhere rather than wondering whether it did anything.
    reply.code(created ? 201 : 200)
    return { workout: { id, created } }
  })
}
