import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { connect, migrate, db } from '@gymyar/db'
import { config } from './config.js'
import { registerRateLimit } from './rate-limit.js'
import authRoutes from './routes/auth.js'
import phoneRoutes from './routes/phone.js'
import emailRoutes from './routes/email.js'
import syncRoutes from './routes/sync.js'
import coachingRoutes from './routes/coaching.js'
import exerciseRoutes from './routes/exercises.js'
import pushRoutes from './routes/push.js'
import adminRoutes from './routes/admin.js'
import aiRoutes from './routes/ai.js'
import billingRoutes from './routes/billing.js'
import mediaRoutes from './routes/media.js'
import publicRoutes from './routes/public.js'
import checkinRoutes from './routes/checkins.js'

export async function build({
  logger = false, databaseUrl = config.databaseUrl, runMigrations = true, ai = null,
  // The payment gateway, injectable for the same reason `ai` is: the suite drives the whole
  // purchase flow, and it must never reach a real terminal to do it.
  gateway = null,
  // The API suite drives hundreds of requests through one client on one key, which is exactly
  // what the limiter exists to stop. Tests turn it off and test it directly instead.
  rateLimit = config.rateLimit,
  // The public counters the project site reads. Injectable for the same reason: the suite has
  // to be able to build an instance with them off and see the route genuinely absent.
  publicStats = config.publicStats
} = {}) {
  connect(databaseUrl)
  if (runMigrations) await migrate()

  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024 })
  await app.register(cookie)
  // Before the routes: the limiter reads the session cookie to decide whose budget a request
  // spends, so it has to be registered after cookies and before anything it protects.
  await registerRateLimit(app, { enabled: rateLimit })

  // Routes throw `Object.assign(new Error(msg), { status })` rather than composing replies, so
  // the permission rules read as rules. This is where that becomes an HTTP response — and where
  // an unexpected error becomes a 500 with its detail logged rather than leaked.
  //
  // Two opt-ins on top of that. `expose` is for a 5xx a route raised on purpose — an upstream
  // that is down is not a bug, and "something went wrong" tells the person nothing they can
  // act on; it is still logged. `details` is structured context the client needs to render the
  // right screen rather than a generic failure, which is what separates "your trial ended" from
  // "your subscription lapsed last week" at a 402.
  app.setErrorHandler((err, req, reply) => {
    const status = err.status || err.statusCode || 500
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error')
      if (!err.expose) return reply.code(500).send({ error: 'something went wrong' })
    }
    reply.code(status).send({
      error: err.message,
      code: err.code,
      ...(err.details ? { details: err.details } : {})
    })
  })

  /* Nothing this API says is cacheable — except the bytes behind a signed media URL, which
   * are immutable, already carry their own expiry in the signature, and are re-requested once
   * per seek by a video element. `no-store` there would mean re-downloading a clip to scrub
   * back five seconds, so those responses set their own header and this one leaves them be. */
  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/media/')) return
    /* — and the public counters, which are the same six numbers for everybody, recomputed
     * every five minutes. That is a response a shared cache is welcome to keep, and the
     * route sets its own `max-age` to say for how long. */
    if (req.url.startsWith('/api/public/')) return
    reply.header('Cache-Control', 'no-store')
  })

  app.get('/api/health', async () => {
    const [{ n }] = await db()`select count(*)::int as n from users`
    return { ok: true, users: n }
  })

  await app.register(authRoutes)
  await app.register(phoneRoutes)
  await app.register(emailRoutes)
  await app.register(syncRoutes)
  await app.register(coachingRoutes)
  await app.register(checkinRoutes)
  await app.register(exerciseRoutes)
  await app.register(pushRoutes)
  await app.register(adminRoutes)
  await app.register(aiRoutes, { ai })
  await app.register(billingRoutes, { gateway })
  await app.register(mediaRoutes)
  await app.register(publicRoutes, { enabled: publicStats })

  return app
}
