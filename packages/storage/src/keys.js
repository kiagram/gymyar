/* Where a stored object lives, and what a caller is allowed to ask for.
 *
 * A key is a relative path with no cleverness in it: lower-case hex, digits, slashes and a
 * single extension. That is not aesthetic. Whatever a key names, the filesystem driver is going
 * to join it onto a directory and open it, so the grammar here *is* the boundary between "a
 * file this instance owns" and "any file the process can read". Everything else in this package
 * assumes a key has been through `assertKey`.
 */

/** The whole allowed grammar. Anchored, and deliberately smaller than it needs to be. */
const KEY = /^[0-9a-f]{2}\/[0-9a-f-]{36}\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/

/**
 * Throw unless `key` is one this package could have produced.
 *
 * A whitelist rather than a search for `..`, because the blacklist version of this check has
 * been got wrong so many times that the list of encodings people have smuggled past it is
 * longer than this file. `..` fails here for the same reason `/etc/passwd` and `%2e%2e` and a
 * NUL byte fail: none of them is two hex digits followed by a slash.
 */
export function assertKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) {
    throw Object.assign(new Error('not a storage key'), { code: 'bad_key' })
  }
  return key
}

export const isKey = key => typeof key === 'string' && KEY.test(key)

/** What each kind of upload is called on disk. The extension is chosen by us, never by a filename. */
const EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg'
}

export const extensionFor = mime => EXT[String(mime || '').toLowerCase()] ?? null

export const supportedTypes = () => Object.keys(EXT)

/**
 * Build the key for a new object: `ab/<owner>/<year>/<month>/<id>.<ext>`.
 *
 * Three levels of sharding, each earning its place. The two leading hex characters of the owner
 * spread everybody across 256 top-level directories, which is what keeps the *root* from being
 * a directory with a hundred thousand entries in it — the thing that makes `ls` hang and some
 * filesystems degrade. The owner's own directory is what makes "delete everything belonging to
 * this person" a directory removal rather than a scan. Year and month bound the leaf: a coach
 * uploading a form check a day fills a directory with about thirty files.
 *
 * The id is the attachment's uuid, so a key is derivable from a row and a row from a key. The
 * date comes from *now* rather than from anything the caller sends, because a key that a
 * request can steer is a key a request can collide.
 */
export function buildKey({ ownerId, id, mime, at = new Date() }) {
  const ext = extensionFor(mime)
  if (!ext) throw Object.assign(new Error(`unsupported type: ${mime}`), { code: 'bad_type' })
  if (!/^[0-9a-f-]{36}$/.test(ownerId)) throw new Error('ownerId must be a uuid')
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('id must be a uuid')

  const yyyy = String(at.getUTCFullYear())
  const mm = String(at.getUTCMonth() + 1).padStart(2, '0')
  return assertKey(`${ownerId.slice(0, 2)}/${ownerId}/${yyyy}/${mm}/${id}.${ext}`)
}

/** The prefix holding everything one account ever uploaded. What account deletion removes. */
export const ownerPrefix = ownerId => {
  if (!/^[0-9a-f-]{36}$/.test(ownerId)) throw new Error('ownerId must be a uuid')
  return `${ownerId.slice(0, 2)}/${ownerId}`
}
