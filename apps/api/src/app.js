import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { connect, migrate, db } from '@gymbuddy/db'
import { config } from './config.js'
import authRoutes from './routes/auth.js'
import syncRoutes from './routes/sync.js'
import coachingRoutes from './routes/coaching.js'
import exerciseRoutes from './routes/exercises.js'
import pushRoutes from './routes/push.js'
import adminRoutes from './routes/admin.js'
import aiRoutes from './routes/ai.js'

export async function build({ logger = false, databaseUrl = config.databaseUrl, runMigrations = true, ai = null } = {}) {
  connect(databaseUrl)
  if (runMigrations) await migrate()

  const app = Fastify({ logger, bodyLimit: 5 * 1024 * 1024 })
  await app.register(cookie)

  // Routes throw `Object.assign(new Error(msg), { status })` rather than composing replies, so
  // the permission rules read as rules. This is where that becomes an HTTP response — and where
  // an unexpected error becomes a 500 with its detail logged rather than leaked.
  app.setErrorHandler((err, req, reply) => {
    const status = err.status || err.statusCode || 500
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error')
      return reply.code(500).send({ error: 'something went wrong' })
    }
    reply.code(status).send({ error: err.message, code: err.code })
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

  return app
}
