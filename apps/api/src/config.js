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
  sessionDays: Math.max(1, +(process.env.SESSION_DAYS || 90) || 90),
  // A generated secret means every restart signs out every user. Fine for a laptop, a data-loss
  // incident in production — so it is refused there rather than silently accepted.
  secret: process.env.SESSION_SECRET || (() => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET must be set in production — a generated one changes on every restart and signs everyone out')
    }
    return crypto.randomBytes(32).toString('hex')
  })(),
  vapid: {
    publicKey: process.env.VAPID_PUBLIC_KEY || null,
    privateKey: process.env.VAPID_PRIVATE_KEY || null,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@localhost'
  }
}

export const secureCookies = /^https:/i.test(config.origin)
