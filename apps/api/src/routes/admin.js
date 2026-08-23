/* The instance dashboard: who is on it, and the invite codes that gate signup.
 * Off unless a user is flagged is_admin, so a fresh instance stays open with no admin at all.
 */
import crypto from 'node:crypto'
import { db } from '@gymbuddy/db'
import { setDisabled } from '@gymbuddy/db/users.js'
import { requireAdmin } from '../session.js'

export default async function adminRoutes(app) {
  app.get('/api/admin/users', async req => {
    await requireAdmin(req)
    const users = await db()`
      select u.id, u.name, u.email, u.is_coach, u.is_admin, u.disabled_at, u.created_at,
             (select count(*)::int from workouts w
               where w.user_id = u.id and w.deleted_at is null and w.finished_at is not null) as sessions,
             (select max(w.finished_at) from workouts w where w.user_id = u.id) as last_trained_at
      from users u order by u.created_at desc`
    return { users }
  })

  app.post('/api/admin/users/:id/disable', async req => {
    await requireAdmin(req)
    await setDisabled(req.params.id, req.body?.disabled !== false)
    return { ok: true }
  })

  app.get('/api/admin/invites', async req => {
    await requireAdmin(req)
    return { invites: await db()`select * from invites order by created_at desc limit 200` }
  })

  app.post('/api/admin/invites', async req => {
    const admin = await requireAdmin(req)
    const code = crypto.randomBytes(4).toString('hex').toUpperCase()
    const [invite] = await db()`
      insert into invites (code, created_by) values (${code}, ${admin.id}) returning *`
    return { invite }
  })

  app.delete('/api/admin/invites/:code', async req => {
    await requireAdmin(req)
    await db()`delete from invites where code = ${req.params.code} and used_by is null`
    return { ok: true }
  })
}
