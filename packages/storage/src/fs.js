/* The filesystem driver: a directory on a volume, served by the nginx that is already there.
 *
 * ## Why this is the default rather than object storage
 *
 * S3, R2 and the CDNs in front of them are not reachable from an Iranian entity — not as a
 * performance question, as an account-you-cannot-open question. An architecture whose happy
 * path is a bucket is an architecture this deployment runs in the sad path forever. A directory
 * on a disk has none of that problem, and the thing it costs — you have to back it up yourself
 * — is a sentence in the self-hosting guide rather than a rewrite.
 *
 * ## Writes land whole or not at all
 *
 * Every put goes to a temporary name in the same directory and is renamed into place. `rename`
 * within one filesystem is atomic, so a reader either sees the finished object or sees nothing;
 * it never sees the first half of a video that a crash interrupted. The alternative — writing
 * straight to the final path — produces objects that `stat` reports as real and that play as
 * corrupt, and the database row pointing at them looks perfectly healthy.
 */
import fs from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { assertKey } from './keys.js'
import { signedPath, DEFAULT_TTL_SECONDS } from './sign.js'

/**
 * Resolve a key against the root, and refuse anything that escapes it.
 *
 * `assertKey` has already rejected everything that could, so this is the second lock on the
 * same door. It stays because the cost is one comparison and the failure it prevents is reading
 * an arbitrary file off the host: a grammar that is one careless edit away from allowing a dot
 * should not be the only thing standing between a query parameter and `/etc/shadow`.
 */
function resolveKey(root, key) {
  assertKey(key)
  const full = path.resolve(root, key)
  const base = path.resolve(root) + path.sep
  if (!full.startsWith(base)) throw Object.assign(new Error('key escapes root'), { code: 'bad_key' })
  return full
}

export function filesystemStorage({ root, secret }) {
  if (!root) throw new Error('filesystem storage needs a root directory')

  return {
    name: 'fs',

    /** Where nginx should read this object from. Filesystem-only — see index.js. */
    internalPath: key => resolveKey(root, key),

    async put({ key, body }) {
      const full = resolveKey(root, key)
      await fs.mkdir(path.dirname(full), { recursive: true })

      // Same directory as the target, so the rename stays within one filesystem and stays
      // atomic. A temp file in the OS temp directory would be a copy across devices instead.
      const tmp = `${full}.${crypto.randomBytes(6).toString('hex')}.part`
      try {
        if (Buffer.isBuffer(body) || typeof body === 'string') {
          await fs.writeFile(tmp, body)
        } else {
          await pipeline(body, createWriteStream(tmp))
        }
        await fs.rename(tmp, full)
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
      const { size } = await fs.stat(full)
      return { key, bytes: size }
    },

    signedUrl(key, { ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() } = {}) {
      return signedPath(key, { secret, ttlSeconds, now })
    },

    /** Null for an object that is not there. Absence is an answer, not an exception. */
    async stat(key) {
      try {
        const { size, mtime } = await fs.stat(resolveKey(root, key))
        return { key, bytes: size, modifiedAt: mtime }
      } catch (err) {
        if (err.code === 'ENOENT') return null
        throw err
      }
    },

    /**
     * Remove the object. True if it was there, false if it already was not.
     *
     * Idempotent on purpose: the caller is a sweeper reconciling rows against bytes, and it
     * will be asked to delete things twice. Empty parent directories are left behind — pruning
     * them races every concurrent put into the same month, and an empty directory costs an
     * inode rather than an incident.
     */
    async delete(key) {
      try {
        await fs.unlink(resolveKey(root, key))
        return true
      } catch (err) {
        if (err.code === 'ENOENT') return false
        throw err
      }
    }
  }
}
