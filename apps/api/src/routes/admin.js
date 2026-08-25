/* The instance dashboard: who is on it, and the invite codes that gate signup.
 * Off unless a user is flagged is_admin, so a fresh instance stays open with no admin at all.
 */
import crypto from 'node:crypto'
import { db } from '@gymbuddy/db'
import { setDisabled } from '@gymbuddy/db/users.js'
import { requireAdmin } from '../session.js'
import { priceIndex } from '../payments/pricing.js'

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

  /**
   * Realised revenue, month by month, in both currencies.
   *
   * Toman is what was charged and USD is what it was worth, and the second one is the reason
   * this endpoint exists: a Toman series cannot be compared with itself across a year in which
   * the currency moved by a third. The dollar column is the only one that answers "is this
   * growing".
   *
   * `unrated` is the honest part. Payments taken before the price index existed carry no rate,
   * so they contribute to the Toman column and not the dollar one — which would make the
   * dollar figure quietly wrong rather than merely incomplete if nobody said how many. A
   * missing rate is never invented after the fact; it is unknowable by then.
   */
  app.get('/api/admin/revenue', async req => {
    await requireAdmin(req)
    // Rials to Toman at the edge, so both columns are in the unit a person quotes prices in.
    const months = await db()`
      select date_trunc('month', settled_at) as month,
             count(*)::int as payments,
             sum(case when currency = 'IRR' then amount / 10.0 else amount end)::float8 as toman,
             sum(case when toman_per_usd is null then null
                      else (case when currency = 'IRR' then amount / 10.0 else amount end)
                           / toman_per_usd end)::float8 as usd,
             count(*) filter (where toman_per_usd is null)::int as unrated
      from payments
      where status = 'paid' and settled_at is not null
      group by 1 order by 1 desc limit 24`

    const byTier = await db()`
      select coalesce(tier, 'untiered') as tier, count(*)::int as payments,
             sum(case when currency = 'IRR' then amount / 10.0 else amount end)::float8 as toman
      from payments where status = 'paid' group by 1 order by 2 desc`

    return { months, byTier, index: priceIndex() }
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
