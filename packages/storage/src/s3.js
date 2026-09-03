/* The S3 driver.
 *
 * This file spent its first life as a deliberate stub — five methods with real signatures and
 * no bodies — to prove that the interface in `index.js` was shaped by what storage *is* rather
 * than by what a directory on a disk happens to make easy. Writing the bodies is how you find
 * out whether that was true, and it mostly was. Two things about the shape held up exactly as
 * the stub predicted:
 *
 * - `signedUrl` is a driver method rather than a shared helper. The filesystem has to invent
 *   signing and does it with an HMAC in `sign.js`; S3 has presigned URLs and uses its own. If
 *   signing lived above the driver this implementation would have had to fight it.
 * - `internalPath` is not in the interface. Serving bytes through nginx's X-Accel-Redirect is a
 *   filesystem answer to a filesystem problem, and `apps/api/src/routes/media.js` already
 *   returns 501 for a driver without it — the S3 answer is that the client goes straight to the
 *   bucket and the origin never sees the request.
 *
 * ## And one thing that did not: `signedUrl` had to become awaitable
 *
 * The stub's own comment claimed nothing above this file would have to change. That was almost
 * right. `getSignedUrl` is async, because resolving credentials can be — an instance role or an
 * STS assumption is a network call before a single byte is hashed — so a driver that presigns
 * through the SDK cannot answer synchronously, and `withUrl` in `apps/api/src/media.js` is now
 * async with its callers awaiting it.
 *
 * The alternative was hand-rolling SigV4 presigning here to keep the signature synchronous,
 * which it can be when credentials are static. That was rejected: it trades a mechanical change
 * at nine call sites, all of them already inside async handlers, for hand-written signing code
 * in a security-adjacent path, and it would have quietly ruled out every credential source that
 * is not two strings in the environment. The filesystem driver still returns a plain string —
 * `await` on a string is a string — so nothing about it changed.
 *
 * ## The SDK arrives late
 *
 * `import()` inside the factory rather than at the top of the file. The overwhelming majority
 * of deployments run `fs` (see that driver for why), and `index.js` imports this module
 * unconditionally, so a static import would make every one of them load the AWS SDK to not use
 * it. Construction stays synchronous and still validates its configuration at boot, which is
 * what `storageFor` and its tests rely on; the SDK loads on the first operation.
 *
 * Who this is for: a self-hoster outside the sanctions problem that made the filesystem driver
 * the default, or a MinIO on the same machine for somebody who would rather back up a bucket.
 */
import { assertKey } from './keys.js'
import { DEFAULT_TTL_SECONDS } from './sign.js'

/* S3 reports a missing object as a 404, and as one of two error names depending on which verb
 * asked. Both mean the same thing here, and that thing is `null` rather than a throw — absence
 * is an answer, exactly as it is for the filesystem. */
const isMissing = err =>
  err?.$metadata?.httpStatusCode === 404 ||
  err?.name === 'NoSuchKey' || err?.name === 'NotFound'

/**
 * Construct the driver. Deliberately does *not* reach the network.
 *
 * Configuration is validated here so that a misconfigured instance fails at boot with a
 * sentence naming the missing variable, rather than at the first upload with a stack trace in
 * front of somebody who was trying to send their coach a video.
 */
export function s3Storage({ bucket, region, endpoint = null, prefix = '', credentials = null, client = null } = {}) {
  if (!bucket) throw new Error('S3 storage needs STORAGE_S3_BUCKET')
  if (!region && !endpoint) throw new Error('S3 storage needs STORAGE_S3_REGION or STORAGE_S3_ENDPOINT')

  /* A prefix lets one bucket hold this instance's objects beside something else's. It is
   * configuration and never comes from a request, so it is joined here and stripped nowhere:
   * every method below takes a key in the product's own grammar and puts the prefix on it, and
   * no key ever comes back out of S3 to be trusted. */
  const at = key => {
    assertKey(key)
    return prefix ? `${prefix.replace(/\/+$/, '')}/${key}` : key
  }

  let pending = null
  const sdk = () => {
    if (!pending) {
      pending = (async () => {
        const [mod, upload, presign] = await Promise.all([
          import('@aws-sdk/client-s3'),
          import('@aws-sdk/lib-storage'),
          import('@aws-sdk/s3-request-presigner')
        ])
        return {
          mod,
          Upload: upload.Upload,
          getSignedUrl: presign.getSignedUrl,
          client: client || new mod.S3Client({
            /* S3 requires a region in the signature even where it means nothing. MinIO and the
             * other endpoint-compatible stores ignore the value but not its absence. */
            region: region || 'us-east-1',
            /* A custom endpoint is a store that is not AWS, and those address a bucket by path
             * rather than by subdomain — `localhost:9000/bucket/key`, since `bucket.localhost`
             * resolves to nothing. */
            ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
            ...(credentials ? { credentials } : {})
          })
        }
      })()
    }
    return pending
  }

  /* Shared by `stat` and `delete`, as a function rather than through `this`: a driver whose
   * methods only work while attached to their object is a driver that breaks the first time
   * somebody destructures it, and nothing in the interface says they may not. */
  const statOf = async key => {
    const { mod, client: s3 } = await sdk()
    try {
      const head = await s3.send(new mod.HeadObjectCommand({ Bucket: bucket, Key: at(key) }))
      return { key, bytes: head.ContentLength, modifiedAt: head.LastModified }
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  return {
    name: 's3',
    config: { bucket, region, endpoint, prefix },

    /**
     * Store the bytes. Returns what the bucket says is there, not what we thought we sent.
     *
     * `Upload` from lib-storage rather than a plain PutObject, because the caller hands this a
     * `Readable` of unknown length — `apps/api/src/routes/media.js` streams the request body
     * through a size check without ever holding it — and PutObject wants a ContentLength it
     * cannot have. Upload does multipart when it has to and a single request when it does not.
     */
    async put({ key, body, contentType }) {
      const { mod, Upload, client: s3 } = await sdk()
      const Key = at(key)
      await new Upload({
        client: s3,
        params: { Bucket: bucket, Key, Body: body, ...(contentType ? { ContentType: contentType } : {}) }
      }).done()

      /* A HEAD after the write, the way the filesystem driver stats the file it just renamed.
       * One extra round trip, and it buys the same property: the size reported to the caller is
       * the object's, so a truncated upload cannot be recorded as a whole one. */
      const head = await s3.send(new mod.HeadObjectCommand({ Bucket: bucket, Key }))
      return { key, bytes: head.ContentLength }
    },

    /**
     * A URL for the object that stops working shortly. Awaitable — see the header.
     *
     * The client fetches this straight from the bucket; unlike the filesystem's signed path it
     * never reaches this origin, which is why the `/media/*` route refuses to serve for a driver
     * without `internalPath` instead of pretending it can.
     */
    async signedUrl(key, { ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
      const { mod, client: s3, getSignedUrl } = await sdk()
      return getSignedUrl(s3, new mod.GetObjectCommand({ Bucket: bucket, Key: at(key) }),
        { expiresIn: Math.max(1, Math.floor(ttlSeconds)) })
    },

    /**
     * The bytes themselves, or null if there are none.
     *
     * Buffered, and the same warning applies as on the filesystem driver: this turns a 60 MB
     * video into 60 MB of heap. It exists for the one caller that cannot be handed a URL — a
     * model being asked to look at a photo — and that caller caps what it asks for.
     */
    async get(key) {
      const { mod, client: s3 } = await sdk()
      try {
        const out = await s3.send(new mod.GetObjectCommand({ Bucket: bucket, Key: at(key) }))
        return Buffer.from(await out.Body.transformToByteArray())
      } catch (err) {
        if (isMissing(err)) return null
        throw err
      }
    },

    /** Null for an object that is not there. The reconciler's only question. */
    stat: statOf,

    /**
     * Remove the object. True if it was there, false if it already was not.
     *
     * DeleteObject succeeds either way and declines to say which happened, so the answer costs
     * a HEAD first. That is a round trip the filesystem gets for free, and it is bought rather
     * than skipped because the caller is a sweeper reconciling rows against bytes: it is told
     * how many objects it actually removed, and "deleted 400" when the real number was 3 is a
     * report that would send somebody looking for a leak that is not there.
     */
    async delete(key) {
      const { mod, client: s3 } = await sdk()
      const existed = await statOf(key) !== null
      await s3.send(new mod.DeleteObjectCommand({ Bucket: bucket, Key: at(key) }))
      return existed
    }
  }
}
