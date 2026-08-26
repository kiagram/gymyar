/* The API's side of storage: one configured driver, and the two things every route needs.
 *
 * Kept out of `routes/media.js` because the coaching routes need it too — a thread renders its
 * attachments, and the signed URL for one is minted by whoever just checked that the reader is
 * in the conversation. Minting is never a client's job and never a screen's: a URL is the
 * permission decision, written down.
 */
import { storageFor, LIMITS } from '@gymbuddy/storage'
import { publicView } from '@gymbuddy/db/attachments.js'
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
 */
export const withUrl = (row, { ttlSeconds = config.media.urlTtl } = {}) => {
  if (!row) return null
  return { ...publicView(row), url: storage().signedUrl(row.storage_key, { ttlSeconds }) }
}

export const withUrls = (rows, opts) => (rows || []).map(r => withUrl(r, opts))

/** The byte ceiling for a kind of upload. Stated by the storage package; read through here. */
export const limitFor = kind => LIMITS[kind] ?? 0
