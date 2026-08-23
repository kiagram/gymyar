import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { connect, migrate, db } from '@gymbuddy/db'
import { config } from './config.js'
import { registerRateLimit } from './rate-limit.js'
import authRoutes from './routes/auth.js'
import syncRoutes from './routes/sync.js'
import coachingRoutes from './routes/coaching.js'
import exerciseRoutes from './routes/exercises.js'
import pushRoutes from './routes/push.js'
import adminRoutes from './routes/admin.js'
import aiRoutes from './routes/ai.js'
import billingRoutes from './routes/billing.js'

export async function build({
  logger = false, databaseUrl = config.databaseUrl, runMigrations = true, ai = null,
  // The payment gateway, injectable for the same reason `ai` is: the suite drives the whole
  // purchase flow, and it must never reach a real terminal to do it.
  gateway = null,
  // The API suite drives hundreds of requests through one client on one key, which is exactly
  // what the limiter exists to stop. Tests turn it off and test it directly instead.
  rateLimit = config.rateLimit
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

  app.addHook('onSend', async (req, reply) => { reply.header('Cache-Control', 'no-store') })

  app.get('/api/health', async () => {
    const [{ n }] = await db()`select count(*)::int as n from users`
    return { ok: true, users: n }
  })

  await app.register(authRoutes)
  await app.register(syncRoutes)
  await app.register(coachingRoutes)
  await app.register(exerciseRoutes)
  await app.register(pushRoutes)
  await app.register(adminRoutes)
  await app.register(aiRoutes, { ai })
  await app.register(billingRoutes, { gateway })

  return app
}
