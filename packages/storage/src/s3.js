/* The S3 driver, deliberately unfinished.
 *
 * This exists to prove one claim and no other: that the interface in `index.js` is shaped by
 * what storage *is* rather than by what a directory on a disk happens to make easy. An
 * abstraction with exactly one implementation is a guess, and the usual way to find out it was
 * the wrong guess is to write the second implementation and discover the interface leaks — a
 * method that only means something to a filesystem, a return value that assumes local paths, a
 * signature scheme baked into the caller.
 *
 * So the five methods are here with their real signatures, and each one throws. Writing the
 * bodies is a dependency (`@aws-sdk/client-s3`) and an afternoon; the point is that nothing
 * above this file would have to change when somebody does.
 *
 * Two things about the shape are worth noting, because they are what the exercise found:
 *
 * - `signedUrl` is a driver method rather than a shared helper. A filesystem has to invent
 *   signing, and this package does that with an HMAC in `sign.js`; S3 already has presigned
 *   URLs and would use its own. If signing lived above the driver, the S3 implementation would
 *   have to fight it.
 * - `internalPath` is *not* in the interface. Serving bytes through nginx's X-Accel-Redirect is
 *   a filesystem answer to a filesystem problem; the S3 answer is that the client goes straight
 *   to the bucket and the origin never sees the request at all. A driver may carry extras its
 *   own serving path needs, and callers reach for them knowingly.
 *
 * Who this is for: a self-hoster outside the sanctions problem that made the filesystem driver
 * the default, or a MinIO on the same machine for somebody who would rather back up a bucket.
 */

const notImplemented = method => {
  throw Object.assign(
    new Error(`S3 storage is a stub: ${method}() is not implemented. Set STORAGE_DRIVER=fs, or finish packages/storage/src/s3.js.`),
    { code: 'not_implemented' }
  )
}

/**
 * Construct the driver. Deliberately does *not* throw.
 *
 * Configuration is validated here so that a misconfigured instance fails at boot with a
 * sentence naming the missing variable, rather than at the first upload with a stack trace in
 * front of somebody who was trying to send their coach a video.
 */
export function s3Storage({ bucket, region, endpoint = null, prefix = '' } = {}) {
  if (!bucket) throw new Error('S3 storage needs STORAGE_S3_BUCKET')
  if (!region && !endpoint) throw new Error('S3 storage needs STORAGE_S3_REGION or STORAGE_S3_ENDPOINT')

  return {
    name: 's3',
    config: { bucket, region, endpoint, prefix },

    // eslint-disable-next-line no-unused-vars
    async put({ key, body, contentType }) { return notImplemented('put') },
    // eslint-disable-next-line no-unused-vars
    signedUrl(key, opts) { return notImplemented('signedUrl') },
    // eslint-disable-next-line no-unused-vars
    async get(key) { return notImplemented('get') },
    // eslint-disable-next-line no-unused-vars
    async stat(key) { return notImplemented('stat') },
    // eslint-disable-next-line no-unused-vars
    async delete(key) { return notImplemented('delete') }
  }
}
