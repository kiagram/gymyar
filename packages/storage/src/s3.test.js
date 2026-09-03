/* The S3 driver, against something that actually speaks S3.
 *
 * `storage.test.js` opens by saying why the filesystem driver is tested against a real
 * directory rather than a mocked `fs`: a fake agrees with the implementation about exactly the
 * things worth doubting. That argument does not weaken when the store is remote — it gets
 * stronger, because the questions here are *S3's* answers and not ours. Does a missing object
 * come back as a 404 or as a named error? Does DeleteObject tell you whether anything was
 * there? Does a presigned URL actually fetch? A hand-written double answers all three the way
 * the driver already believes, which is worth nothing.
 *
 * So: MinIO, which is a real S3 API. `STORAGE_S3_TEST_ENDPOINT` points at one, CI stands one up
 * beside the Postgres, and without it the whole file skips rather than pretending. To run it
 * locally:
 *
 *   docker run --rm -p 9000:9000 -e MINIO_ROOT_USER=gymyar \
 *     -e MINIO_ROOT_PASSWORD=gymyar-secret minio/minio server /data
 *   STORAGE_S3_TEST_ENDPOINT=http://127.0.0.1:9000 STORAGE_S3_ACCESS_KEY_ID=gymyar \
 *     STORAGE_S3_SECRET_ACCESS_KEY=gymyar-secret npm run test -w @gymyar/storage
 *
 * What is *not* here: the driver's construction and its refusal to build without a bucket or a
 * region. Those need no server and live in `storage.test.js` with the rest of `storageFor`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { s3Storage, buildKey } from './index.js'

const ENDPOINT = process.env.STORAGE_S3_TEST_ENDPOINT
const CREDS = {
  accessKeyId: process.env.STORAGE_S3_ACCESS_KEY_ID || 'gymyar',
  secretAccessKey: process.env.STORAGE_S3_SECRET_ACCESS_KEY || 'gymyar-secret'
}
const OWNER = '11111111-2222-3333-4444-555555555555'
const BUCKET = 'gymyar-test'

// A distinct id per key, so a re-run against a bucket somebody forgot to empty cannot pass by
// reading what the previous run left behind.
let n = 0
const key = (mime = 'video/mp4') =>
  buildKey({ ownerId: OWNER, id: `aaaaaaaa-bbbb-cccc-dddd-${String(++n).padStart(12, '0')}`, mime })

const driver = (opts = {}) =>
  s3Storage({ bucket: BUCKET, region: 'us-east-1', endpoint: ENDPOINT, credentials: CREDS, ...opts })

describe.skipIf(!ENDPOINT)('the S3 driver, against a real S3 API', () => {
  let store

  beforeAll(async () => {
    const { S3Client, CreateBucketCommand } = await import('@aws-sdk/client-s3')
    const admin = new S3Client({
      region: 'us-east-1', endpoint: ENDPOINT, forcePathStyle: true, credentials: CREDS
    })
    try {
      await admin.send(new CreateBucketCommand({ Bucket: BUCKET }))
    } catch (err) {
      // Ours already, from a previous run. Anything else is a real failure and should surface
      // here rather than as five confusing assertion errors below.
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(err.name || '')) throw err
    }
    store = driver()
  })
  afterAll(() => store = null)

  it('stores a buffer and reports the size the bucket holds, not the one we sent', async () => {
    const k = key('image/jpeg')
    const out = await store.put({ key: k, body: Buffer.from('hello bucket'), contentType: 'image/jpeg' })
    expect(out).toEqual({ key: k, bytes: 12 })
  })

  it('stores a stream of unknown length, which is what the upload route hands it', async () => {
    /* The load-bearing one. `apps/api/src/routes/media.js` streams the request body through a
     * size check and never holds it, so the driver is handed a `Readable` with no
     * ContentLength — which a plain PutObject cannot take. This is the assertion that says the
     * lib-storage `Upload` is not decoration. */
    const k = key()
    const body = Readable.from([Buffer.from('one '), Buffer.from('two '), Buffer.from('three')])
    expect(await store.put({ key: k, body, contentType: 'video/mp4' })).toEqual({ key: k, bytes: 13 })
    expect((await store.get(k)).toString()).toBe('one two three')
  })

  it('reads back exactly the bytes, for the one caller that needs them in the process', async () => {
    const k = key('image/jpeg')
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    await store.put({ key: k, body: bytes, contentType: 'image/jpeg' })
    expect(await store.get(k)).toEqual(bytes)
  })

  it('answers null for an object that is not there, rather than throwing', async () => {
    // Absence is an answer here exactly as it is on the filesystem. Both verbs, because S3
    // names the 404 differently depending on which one asked.
    const k = key()
    expect(await store.stat(k)).toBe(null)
    expect(await store.get(k)).toBe(null)
  })

  it('stats an object it stored', async () => {
    const k = key('image/jpeg')
    await store.put({ key: k, body: Buffer.from('12345'), contentType: 'image/jpeg' })
    const info = await store.stat(k)
    expect(info.key).toBe(k)
    expect(info.bytes).toBe(5)
    expect(info.modifiedAt).toBeInstanceOf(Date)
  })

  it('says whether a delete deleted anything, which S3 will not', async () => {
    /* DeleteObject succeeds against a key that was never there and reports the same thing
     * either way. The sweeper reconciling rows against bytes is told how many objects it
     * actually removed, so the driver buys that answer with a HEAD first. */
    const k = key()
    await store.put({ key: k, body: Buffer.from('x'), contentType: 'video/mp4' })
    expect(await store.delete(k)).toBe(true)
    expect(await store.delete(k)).toBe(false)
    expect(await store.stat(k)).toBe(null)
  })

  it('mints a URL that fetches the bytes and then stops working', async () => {
    const k = key('image/jpeg')
    await store.put({ key: k, body: Buffer.from('signed bytes'), contentType: 'image/jpeg' })

    const url = await store.signedUrl(k, { ttlSeconds: 60 })
    expect(url).toContain(BUCKET)
    const ok = await fetch(url)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toBe('signed bytes')

    // And the expiry is real rather than decorative. One second, then wait it out — S3 rejects
    // on its own clock, so this is the store's answer and not ours.
    const brief = await store.signedUrl(k, { ttlSeconds: 1 })
    await new Promise(r => setTimeout(r, 1500))
    expect((await fetch(brief)).status).toBe(403)
  })

  it('refuses a key that is not one, before it reaches the network', async () => {
    // `assertKey` is the same boundary the filesystem driver leans on, applied here too so a
    // traversal attempt cannot become a bucket path.
    await expect(store.stat('../../etc/passwd')).rejects.toThrow()
    await expect(store.get('nope')).rejects.toThrow()
  })

  describe('a prefix', () => {
    it('puts this instance\'s objects under it, and reads them back by the plain key', async () => {
      /* The caller never sees the prefix: it hands the product's own key and gets it back. What
       * this proves is that the prefix is applied on every verb rather than on put alone —
       * which would store objects nothing could ever find again. */
      const prefixed = driver({ prefix: 'instance-a/' })
      const k = key('image/jpeg')
      await prefixed.put({ key: k, body: Buffer.from('under a prefix'), contentType: 'image/jpeg' })

      expect((await prefixed.stat(k)).bytes).toBe(14)
      expect((await prefixed.get(k)).toString()).toBe('under a prefix')
      // And it is genuinely somewhere else: the unprefixed driver cannot see it.
      expect(await store.stat(k)).toBe(null)
      expect(await prefixed.delete(k)).toBe(true)
    })

    it('keeps two instances out of each other\'s objects in one bucket', async () => {
      const a = driver({ prefix: 'a' }), b = driver({ prefix: 'b' })
      const k = key('image/jpeg')
      await a.put({ key: k, body: Buffer.from('a'), contentType: 'image/jpeg' })
      expect(await b.stat(k)).toBe(null)
      expect(await a.delete(k)).toBe(true)
    })
  })
})
