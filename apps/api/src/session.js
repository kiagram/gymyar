/* Signed-cookie sessions, carried over from openGym with the user lookup moved to Postgres.
 *
 * Payload is `<uid>:<expiry>:<version>`. The version is the user's `session_version`; bumping it
 * makes every cookie ever issued for that account stop verifying — on every device, including
 * one someone walked off with. That is the only revocation there is, and it is worth keeping.
 */
import crypto from 'node:crypto'
import { findUserById } from '@gymbuddy/db/users.js'
import { config, secureCookies } from './config.js'

const COOKIE = 'gymsid'

const sign = payload => {
  const mac = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

function verify(token) {
  const i = token.lastIndexOf('.')
  if (i < 0) return null
  const payload = token.slice(0, i)
  const mac = token.slice(i + 1)
  const expect = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url')
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null
  } catch { return null }        // different lengths — timingSafeEqual throws rather than returns
  return payload
}

export function issue(reply, user) {
  const exp = Date.now() + config.sessionDays * 86400000
  reply.setCookie(COOKIE, sign(`${user.id}:${exp}:${user.session_version}`), {
    path: '/', httpOnly: true, sameSite: 'lax',
    secure: secureCookies, maxAge: config.sessionDays * 86400
  })
}

export const clear = reply =>
  reply.setCookie(COOKIE, '', { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 0 })

export async function currentUser(req) {
  const token = req.cookies?.[COOKIE]
  if (!token) return null
  const payload = verify(token)
  if (!payload) return null
  const [uid, exp, version] = payload.split(':')
  if (!uid || Number(exp) < Date.now()) return null
  const user = await findUserById(uid)
  if (!user || user.disabled_at) return null
  if (Number(version) !== user.session_version) return null
  return user
}

/** Route guard. Throws a 401 the error handler turns into a clean response. */
export async function requireUser(req) {
  const user = await currentUser(req)
  if (!user) throw Object.assign(new Error('not signed in'), { status: 401 })
  req.user = user
  return user
}

export async function requireAdmin(req) {
  const user = await requireUser(req)
  if (!user.is_admin) throw Object.assign(new Error('forbidden'), { status: 403 })
  return user
}
