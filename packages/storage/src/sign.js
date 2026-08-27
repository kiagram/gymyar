/* Signed URLs for objects that no web server is allowed to hand out on its own.
 *
 * ## Why a signature and not a session check
 *
 * The bytes are served by nginx, not by Node — a video streamed through a Fastify handler is a
 * request occupying an event loop for the length of the video, and there is no reason for the
 * application to touch a single byte of it. But nginx has no idea who a client is or which
 * scopes their coach was granted, so something has to carry that decision from the place that
 * can make it to the place that serves the file. A signature is that something: the API decides
 * once, and the answer is a URL that stops working shortly afterwards.
 *
 * ## Minutes, not hours
 *
 * A signed URL is a bearer token for one file. It ends up in browser history, in a proxy log,
 * in whatever a client's phone syncs to a desktop, and in the referrer of anything the page
 * loads afterwards. None of that is worth fixing; it is worth *outliving*. A few minutes is
 * long enough to start playing a video and short enough that a leaked link is a curiosity
 * rather than an exposure.
 *
 * ## A sibling of the session secret, never the session secret
 *
 * Signing both with one key means a bug in either verifier is a bug in both, and it means a
 * media URL and a session cookie are forgeable with the same stolen string. So the key here is
 * derived from `SESSION_SECRET` through a fixed label — different key, same rotation. Rotating
 * the session secret invalidates outstanding media links too, which is the correct blast radius
 * for "the secret leaked" and a harmless one for "we rotate quarterly": the longest anything
 * breaks for is the TTL.
 */
import crypto from 'node:crypto'
import { assertKey } from './keys.js'

/* Domain separation. Changing this string rotates every outstanding URL and nothing else, which
 * is what the version suffix is there to make possible. */
const LABEL = 'gymyar/storage-url/v1'

/** How long a link lives when nobody says. Minutes — see the header. */
export const DEFAULT_TTL_SECONDS = 300

/**
 * The signing key: HMAC(sessionSecret, label).
 *
 * A one-shot HKDF-expand, which is enough here because the input is already a high-entropy
 * secret rather than a password. `STORAGE_URL_SECRET` overrides it for an instance that wants
 * media links and sessions to rotate independently; almost nobody does, and it is not the
 * default because a second secret is a second thing to lose.
 */
export function urlKey(sessionSecret) {
  const explicit = process.env.STORAGE_URL_SECRET
  if (explicit) return Buffer.from(explicit, 'utf8')
  if (!sessionSecret) throw new Error('storage URL signing needs SESSION_SECRET')
  return crypto.createHmac('sha256', sessionSecret).update(LABEL).digest()
}

const mac = (key, payload) =>
  crypto.createHmac('sha256', key).update(payload).digest('base64url')

/**
 * Sign `key` until `expiresAt` (epoch seconds).
 *
 * The expiry is inside the signed payload rather than beside it, so moving it is forging it.
 */
export function signKey(key, { secret, expiresAt }) {
  assertKey(key)
  return mac(urlKey(secret), `${key}\n${expiresAt}`)
}

/** A relative URL for `key`, valid for `ttlSeconds`. Relative because the origin is one origin. */
export function signedPath(key, { secret, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() }) {
  const expiresAt = Math.floor(now / 1000) + Math.max(1, Math.floor(ttlSeconds))
  const sig = signKey(key, { secret, expiresAt })
  return `/media/${key}?e=${expiresAt}&s=${sig}`
}

/**
 * Is this signature good for this key, right now?
 *
 * Order matters: the key is validated before anything is hashed, and the comparison is constant
 * time. `timingSafeEqual` throws rather than returning false when the lengths differ, which is
 * the normal case for a mangled parameter, so it is caught.
 */
export function verify(key, { secret, expiresAt, sig, now = Date.now() }) {
  if (!isKeyish(key) || !sig) return false
  const exp = Number(expiresAt)
  if (!Number.isFinite(exp) || exp * 1000 < now) return false
  let expect
  try { expect = signKey(key, { secret, expiresAt: exp }) } catch { return false }
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))
  } catch { return false }
}

const isKeyish = key => {
  try { assertKey(key); return true } catch { return false }
}
