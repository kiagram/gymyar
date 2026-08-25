/* Where uploaded bytes live.
 *
 * This is the first user data in GymBuddy that is not a row in Postgres. Everything else — every
 * set, every programme, every message — is in the database, which is why `docs/SELF_HOSTING.md`
 * has been able to say "the database is the backup" and mean it. Form-check video and progress
 * photos cannot be that, so this package is the seam where they stop being the database's
 * problem and start being a volume's.
 *
 * ## The interface, and why it is four methods
 *
 *   put({ key, body, contentType })  →  { key, bytes }
 *   signedUrl(key, { ttlSeconds })   →  a URL that stops working shortly
 *   stat(key)                        →  { key, bytes, modifiedAt } | null
 *   delete(key)                      →  true if it was there
 *
 * That is the whole thing, and keeping it that way is the point rather than an aesthetic. Every
 * method added here is a method the S3 driver has to answer for, and the ones that get proposed
 * — list, copy, move, a directory walk — are almost always a caller reaching for the filesystem
 * through the abstraction instead of asking the database, which already knows what exists
 * because it has a row for each of them. `attachments` is the index. This is a bag of bytes.
 *
 * `stat` earns its place by being the reconciler's only question: the database says this object
 * exists, does it? Nothing else can answer that.
 *
 * ## Keys are built here, never received
 *
 * A key is derived from the owner, the attachment id and the clock — see `keys.js`. No part of
 * it comes from a request, and no filename a client sends is ever used for anything. That is
 * what makes the grammar in `assertKey` a boundary rather than a formality.
 */
import { filesystemStorage } from './fs.js'
import { s3Storage } from './s3.js'

export { buildKey, assertKey, isKey, ownerPrefix, extensionFor, supportedTypes } from './keys.js'
export { signedPath, verify, urlKey, DEFAULT_TTL_SECONDS } from './sign.js'
export { filesystemStorage } from './fs.js'
export { s3Storage } from './s3.js'

/** Bytes a single upload may be, per kind. Enforced at the edge; stated here so both agree. */
export const LIMITS = {
  photo: +(process.env.MAX_PHOTO_BYTES || 8 * 1024 * 1024),
  video: +(process.env.MAX_VIDEO_BYTES || 60 * 1024 * 1024),
  audio: +(process.env.MAX_AUDIO_BYTES || 8 * 1024 * 1024)
}

/** How long a form-check video may run. A cap the phone applies at capture, not on rejection. */
export const MAX_VIDEO_SECONDS = +(process.env.MAX_VIDEO_SECONDS || 60)

/**
 * The driver this deployment is configured for.
 *
 * Read per call rather than frozen at import, matching `billingConfig()` — the test suite
 * stands up more than one instance in a process, and a module-load-order dependency is a bug
 * that only shows up in whichever file happens to import first.
 */
export function storageFor({ secret, env = process.env } = {}) {
  const driver = (env.STORAGE_DRIVER || 'fs').toLowerCase()

  if (driver === 's3') {
    return s3Storage({
      bucket: env.STORAGE_S3_BUCKET,
      region: env.STORAGE_S3_REGION,
      endpoint: env.STORAGE_S3_ENDPOINT || null,
      prefix: env.STORAGE_S3_PREFIX || ''
    })
  }
  if (driver !== 'fs') {
    throw new Error(`unknown STORAGE_DRIVER: ${driver} (expected 'fs' or 's3')`)
  }
  return filesystemStorage({ root: env.STORAGE_PATH || '/data/media', secret })
}
