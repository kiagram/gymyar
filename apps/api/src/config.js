import crypto from 'node:crypto'

const bool = v => /^(1|true|yes|on)$/i.test(v || '')

export const config = {
  port: +(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL,
  origin: process.env.ORIGIN || 'http://localhost:8080',
  rpId: process.env.RP_ID || 'localhost',
  rpName: process.env.RP_NAME || 'GymBuddy',
  inviteOnly: bool(process.env.INVITE_ONLY),
  // On by default. A single-user instance on a home server has nobody to rate limit, and the
  // test suite drives hundreds of requests through one client — both want it off.
  rateLimit: !/^(0|false|no|off)$/i.test(process.env.RATE_LIMIT || 'on'),
  sessionDays: Math.max(1, +(process.env.SESSION_DAYS || 90) || 90),
  // A generated secret means every restart signs out every user. Fine for a laptop, a data-loss
  // incident in production — so it is refused there rather than silently accepted.
  secret: process.env.SESSION_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set in production — a generated one changes on every restart and signs everyone out')
    }
    return crypto.randomBytes(32).toString('hex')
  })(),
  media: {
    /* Whether nginx is in front and willing to serve the bytes itself.
     *
     * On, the API answers a media request with `X-Accel-Redirect` and no body: it has verified
     * the signature, and nginx streams the file — including range requests, which is what makes
     * seeking in a video work without Node holding an event loop open for the length of it.
     *
     * Off, Node serves the file. That is the dev stack (vite proxying straight to this process,
     * no nginx anywhere) and the test suite, and it is why the fallback exists at all rather
     * than being a second production path: an instance that sets this wrongly serves empty
     * bodies, which is a misconfiguration that should be visible in one request.
     */
    accel: bool(process.env.STORAGE_ACCEL),
    /* How long a media URL lives. Minutes — see packages/storage/src/sign.js for why. */
    urlTtl: Math.max(30, +(process.env.MEDIA_URL_TTL || 300) || 300),
    /* Everything one account may hold at once. Zero is unlimited, which is the right answer
     * for a household instance and the wrong one for anything with a signup form: an upload
     * endpoint with no ceiling is a bill somebody else writes. */
    quotaBytes: Math.max(0, +(process.env.MAX_MEDIA_BYTES_PER_USER ?? 2 * 1024 * 1024 * 1024) || 0)
  },
  /* Where a link in an email points.
   *
   * `origin` already exists for WebAuthn, which needs it to match the page exactly — so it is
   * the same value and there is nothing new to misconfigure. It is worth saying out loud that
   * an instance with the default `http://localhost:8080` will email links nobody else can open;
   * that is the same sentence as "set ORIGIN before you let anyone else sign up".
   */
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || null,
    privateKey: process.env.VAPID_PRIVATE_KEY || null,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@localhost'
  }
}

export const secureCookies = /^https:/i.test(config.origin)
