/* The instance dashboard: who is on it, and the invite codes that gate signup.
 * Off unless a user is flagged is_admin, so a fresh instance stays open with no admin at all.
 */
import crypto from 'node:crypto'
import { db } from '@gymyar/db'
import { setDisabled, setRoles, activeAdminCount, findUserById } from '@gymyar/db/users.js'
import { setPaidThrough } from '@gymyar/db/billing.js'
import { requireAdmin } from '../session.js'
import { priceIndex } from '../payments/pricing.js'

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status })

/** The user this route is about, or a 404 rather than a silent no-op on a bad id. */
async function target(id) {
  const user = await findUserById(id)
  if (!user) throw bad('no such account', 404)
  return user
}

/**
 * Refuse the change that would leave the instance with nobody who can administer it.
 *
 * Demoting the last admin and disabling the last admin are the same accident wearing two
 * hats, and both are unrecoverable from inside the product — the way back is the `psql`
 * prompt in SELF_HOSTING.md, which is the thing these routes exist to stop being mandatory.
 * So it is checked here rather than trusted to the screen: a second admin tab, or a `curl`,
 * would both walk straight past a disabled button.
 *
 * Counted rather than compared against the caller's own id on purpose. "You cannot demote
 * yourself" is the wrong rule in both directions: it blocks a handover between two admins,
 * which is fine and normal, and it permits the last two admins demoting each other.
 */
async function keepAnAdmin(user, { stillAdmin }) {
  if (!user.is_admin || user.disabled_at) return      // not currently one of the admins in the count
  if (stillAdmin) return
  if (await activeAdminCount() <= 1) {
    throw bad('this is the only admin left — promote somebody else first', 409)
  }
}

/** A boolean, or undefined for "leave this one alone". Anything else is a typo, not a value. */
const flag = v => {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'boolean') throw bad('isCoach and isAdmin must be true or false')
  return v
}

export default async function adminRoutes(app) {
  app.get('/api/admin/users', async req => {
    await requireAdmin(req)
    /* The subscription rides along rather than being fetched per row. It is what turns "who is
     * on this instance" into "who is on it and paying", and a left join because most accounts
     * are clients, who never have a subscription row and are not missing anything by it. */
    const users = await db()`
      select u.id, u.name, u.email, u.is_coach, u.is_admin, u.disabled_at, u.created_at,
             sub.tier, sub.client_cap, sub.paid_through, sub.trial_ends_at,
             (select count(*)::int from workouts w
               where w.user_id = u.id and w.deleted_at is null and w.finished_at is not null) as sessions,
             (select max(w.finished_at) from workouts w where w.user_id = u.id) as last_trained_at
      from users u
      left join subscriptions sub on sub.user_id = u.id
      order by u.created_at desc`
    return { users }
  })

  app.post('/api/admin/users/:id/disable', async req => {
    await requireAdmin(req)
    const disabled = req.body?.disabled !== false
    const user = await target(req.params.id)
    // Disabling an admin removes them from the count as surely as demoting them does.
    if (disabled) await keepAnAdmin(user, { stillAdmin: false })
    await setDisabled(user.id, disabled)
    return { ok: true }
  })

  /**
   * Promote and demote, which until now was an `update users set is_admin = true` typed into
   * psql — the one step in SELF_HOSTING.md that cannot be done from the product it documents.
   *
   * Both flags are optional and independent: coach and admin are unrelated capabilities, and
   * sending one must not clear the other.
   */
  app.post('/api/admin/users/:id/roles', async req => {
    await requireAdmin(req)
    const isCoach = flag(req.body?.isCoach)
    const isAdmin = flag(req.body?.isAdmin)
    if (isCoach === undefined && isAdmin === undefined) throw bad('nothing to change')

    const user = await target(req.params.id)
    await keepAnAdmin(user, { stillAdmin: isAdmin === undefined ? user.is_admin : isAdmin })

    /* No `bumpSessionVersion`. Authorisation is read from the row on every request —
     * `requireAdmin` goes through `findUserById` — so a change takes effect on the next call
     * without signing anybody out. Disabling is the one that needs the sessions gone, and
     * `setDisabled` is where that belongs. */
    return { user: await setRoles(user.id, { isCoach, isAdmin }) }
  })

  /**
   * Set a paid-through date by hand: comps, refunds and support fixes.
   *
   * `setPaidThrough` has carried the comment "Admin-side: set a paid-through date directly"
   * since billing landed and has never had an admin side to be called from. This is it.
   *
   * ISO only, and rejected rather than guessed at when it is not — `Date.parse` reads
   * "03/09/2026" the American way without complaint, and a comped subscription that silently
   * lands six months from where it was meant to is a support ticket, not an error anybody sees.
   */
  app.post('/api/admin/users/:id/subscription', async req => {
    await requireAdmin(req)
    const user = await target(req.params.id)
    const raw = req.body?.paidThrough

    // Null clears it — the refund case. Distinct from "no row", which is never having paid.
    if (raw === null) return { subscription: await setPaidThrough(user.id, null) }

    const str = String(raw ?? '').trim()
    if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(str)) {
      throw bad('paidThrough must be an ISO date (2026-09-05) or null')
    }
    const at = new Date(str.replace(' ', 'T'))
    if (!isFinite(at.getTime())) throw bad('that is not a real date')

    return { subscription: await setPaidThrough(user.id, at) }
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
