/* The endpoints that replace `GET/PUT /api/data`.
 *
 *   GET  /api/sync?since=N   → { cursor, changes }   what changed since N
 *   GET  /api/sync/all       → { cursor, changes }   everything, for a first sync
 *   POST /api/sync           → { cursor }            apply these changes
 *
 * The client sends only what it has actually touched and receives only what it has not seen.
 * A phone that has been in a locker for a week costs one small request instead of the entire
 * training history in both directions.
 */
import { pull, pullAll, push } from '@gymbuddy/db/sync.js'
import { requireUser } from '../session.js'

const MAX_ROWS = 5000

export default async function syncRoutes(app) {
  app.get('/api/sync', async req => {
    const user = await requireUser(req)
    const since = Math.max(0, Number(req.query?.since) || 0)
    return pull(user.id, since)
  })

  app.get('/api/sync/all', async req => {
    const user = await requireUser(req)
    return pullAll(user.id)
  })

  app.post('/api/sync', async req => {
    const user = await requireUser(req)
    const payload = req.body?.changes ?? {}
    const rows = ['routines', 'workouts', 'bodyweight', 'exercises', 'weekPlan', 'dayOverrides']
      .reduce((n, k) => n + (payload[k]?.length || 0), 0)
    // A bound, not a policy: a client with more than this to say has lost its cursor and should
    // be doing a full resync, not one enormous transaction that blocks everyone else's writes.
    if (rows > MAX_ROWS) {
      throw Object.assign(
        new Error(`too many rows in one push (${rows}); resync instead`),
        { status: 413 })
    }
    return push(user.id, payload)
  })
}
