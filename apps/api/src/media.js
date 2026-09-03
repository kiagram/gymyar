/* The API's side of storage: one configured driver, and the two things every route needs.
 *
 * Kept out of `routes/media.js` because the coaching routes need it too — a thread renders its
 * attachments, and the signed URL for one is minted by whoever just checked that the reader is
 * in the conversation. Minting is never a client's job and never a screen's: a URL is the
 * permission decision, written down.
 */
import { storageFor, LIMITS } from '@gymyar/storage'
import { publicView } from '@gymyar/db/attachments.js'
import { config } from './config.js'

let cached = null

/**
 * The driver, built once.
 *
 * Cached here rather than per call because the filesystem driver holds a root and a secret and
 * constructing it does no I/O — but `storageFor` reads the environment, and the API suite
 * stands up instances with different roots in one process. `resetStorage()` is how a test says
 * so; nothing in production calls it.
 */
export const storage = () => (cached ??= storageFor({ secret: config.secret }))
export const resetStorage = () => { cached = null }

/**
 * What a client gets for one attachment: the row it may see, plus a URL that stops working.
 *
 * The two are minted together on purpose. Every path that returns an attachment has just
 * finished deciding whether this reader may have it, and that decision is the only thing that
 * should ever produce a URL — a screen holding a bare storage key would be a screen able to
 * ask for bytes it was never granted.
 *
 * Async because one driver's answer is. The filesystem signs with an HMAC and could return a
 * string; S3 presigns through the SDK, whose credential resolution may itself be a network call,
 * so `signedUrl` is awaited rather than read. Awaiting the filesystem's plain string costs a
 * microtask and changes nothing about it — see packages/storage/src/s3.js, which is where the
 * one place this interface leaked is written down.
 */
export const withUrl = async (row, { ttlSeconds = config.media.urlTtl } = {}) => {
  if (!row) return null
  return { ...publicView(row), url: await storage().signedUrl(row.storage_key, { ttlSeconds }) }
}

/* `Promise.all` rather than a loop: these are independent, and on the filesystem they do not
 * wait for anything at all. */
export const withUrls = (rows, opts) => Promise.all((rows || []).map(r => withUrl(r, opts)))

/** The byte ceiling for a kind of upload. Stated by the storage package; read through here. */
export const limitFor = kind => LIMITS[kind] ?? 0
