/* The iPhone's way in: a token a shortcut can carry, and a session it can push.
 *
 * docs/WEARABLES.md M3, and the reasoning for the whole shape of it is in the header of
 * `migrations/015_health_shortcut.sql`. In one line: there is no native iOS app to read
 * HealthKit from and there is not going to be one, so the phone pushes instead — an automation
 * on *when a workout ends*, a `Get Contents of URL`, and this.
 *
 * Two things live here because they are two halves of one flow. Neither is reachable from the
 * app's own sync: a shortcut has no cookie jar, and a session that arrives this way has to be
 * able to arrive twice.
 */
import crypto from 'node:crypto'
import { db, logChange } from './index.js'

/* Domain separation, exactly as in codes.js — an opaque constant, not a description. Changing
 * it invalidates every outstanding token and nothing else. */
const LABEL = 'gymyar/health-token/v1'

let key = null
function tokenKey() {
  if (key) return key
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('health tokens need SESSION_SECRET — a token hashed with nothing is a token stored in the clear')
  key = crypto.createHmac('sha256', secret).update(LABEL).digest()
  return key
}
/** For tests, and for nothing else: the key is derived from an environment read at first use. */
export const _resetKey = () => { key = null }

/* Keyed, like a verification code, though the argument is weaker here and worth being honest
 * about: 32 random bytes are not brute-forceable and a plain SHA-256 would do. It is keyed
 * anyway because the cost is one line and it means a leaked database *alone* — a backup, a
 * misconfigured replica — is not enough to mint a request against this instance. */
const hashToken = token =>
  crypto.createHmac('sha256', tokenKey()).update(String(token)).digest('base64url')

/* Long enough that nobody will ever brute-force it, and typed by nobody: this is copied out of
 * a settings screen and pasted into a shortcut once. base64url so it survives being a header
 * value, a URL and a QR code without anything having to escape it. */
const mint = () => crypto.randomBytes(32).toString('base64url')

/**
 * A new token for this user. The only time the plaintext exists is in this return value.
 *
 * Several are allowed at once on purpose — somebody with an iPhone and an iPad wants a token
 * per device, and being able to revoke one without breaking the other is the point of that.
 */
export async function issueHealthToken(userId, s = db()) {
  const token = mint()
  const [row] = await s`
    insert into health_tokens (user_id, token_hash)
    values (${userId}, ${hashToken(token)})
    returning id, created_at`
  return { id: row.id, createdAt: row.created_at, token }
}

/** The live tokens on an account, without anything secret in them. */
export const healthTokensOf = (userId, s = db()) => s`
  select id, created_at, last_used_at from health_tokens
  where user_id = ${userId} and revoked_at is null
  order by created_at`

/** Kill one. Scoped to its owner, so an id from somewhere else revokes nothing. */
export async function revokeHealthToken(userId, id, s = db()) {
  const rows = await s`
    update health_tokens set revoked_at = now()
    where id = ${id} and user_id = ${userId} and revoked_at is null
    returning id`
  return rows.length > 0
}

/**
 * Whose token this is, or null.
 *
 * `last_used_at` is written on every accepted request. It is the only way somebody can answer
 * "is this thing still running?" about an automation that fires silently on a phone in a
 * pocket, which is most of what people will want to know about this feature.
 */
export async function userForHealthToken(token, s = db()) {
  if (!token || typeof token !== 'string') return null
  const rows = await s`
    update health_tokens set last_used_at = now()
    where token_hash = ${hashToken(token)} and revoked_at is null
    returning user_id`
  return rows.length ? rows[0].user_id : null
}

/* ---------------------------------------------------------------- session ---- */

/**
 * Record a session pushed in from a phone, once, however many times it arrives.
 *
 * Idempotent on `(user_id, external_id)` because the plan says so and the plan is right:
 * automations re-fire, and people re-run a shortcut by hand when they think nothing happened.
 * The second arrival updates the first row — it does not add a second and it does not fail, so
 * a shortcut with no error handling in it can be run twice by a confused person with no
 * consequence either time.
 *
 * The sets are replaced wholesale for the same reason `sync.js` replaces them: the session is
 * the unit that was pushed, and nobody else is writing it.
 *
 * @returns { id, created } — `created` false means this session was already here
 */
export async function recordHealthWorkout(userId, w, s = db()) {
  return s.begin(async tx => {
    const existing = await tx`
      select id from workouts where user_id = ${userId} and external_id = ${w.externalId}`
    const id = existing.length ? existing[0].id : `hk${crypto.randomBytes(9).toString('base64url')}`

    await tx`
      insert into workouts (id, user_id, external_id, routine_id, routine_name,
                            started_at, finished_at, prs,
                            hr_avg_bpm, hr_min_bpm, hr_max_bpm, hr_samples)
      values (${id}, ${userId}, ${w.externalId}, null, ${w.name ?? null},
              ${w.startedAt}, ${w.finishedAt ?? null}, ${[]},
              ${w.hr?.avg ?? null}, ${w.hr?.min ?? null},
              ${w.hr?.max ?? null}, ${w.hr?.n ?? null})
      on conflict (id) do update set
        routine_name = excluded.routine_name, started_at = excluded.started_at,
        finished_at = excluded.finished_at, hr_avg_bpm = excluded.hr_avg_bpm,
        hr_min_bpm = excluded.hr_min_bpm, hr_max_bpm = excluded.hr_max_bpm,
        hr_samples = excluded.hr_samples, deleted_at = null, updated_at = now()`

    await tx`delete from workout_sets where workout_id = ${id}`
    if (w.sets?.length) {
      await tx`insert into workout_sets ${tx(
        w.sets.map((st, i) => ({
          id: `${id}:${i}`, workout_id: id, user_id: userId,
          exercise_id: st.exerciseId, position: i,
          weight_kg: null, reps: null,
          seconds: st.seconds ?? null, distance_m: st.distanceM ?? null,
          per_side: false, effort_value: null, effort_scale: null,
          is_warmup: false, done: true, done_at: w.finishedAt ?? w.startedAt,
          hr_peak_bpm: null
        })),
        'id', 'workout_id', 'user_id', 'exercise_id', 'position', 'weight_kg', 'reps',
        'seconds', 'distance_m', 'per_side', 'effort_value', 'effort_scale', 'is_warmup',
        'done', 'done_at', 'hr_peak_bpm')}`
    }

    // Logged whichever way it went, so a phone that is already syncing picks the session up on
    // its next pull rather than the next time something else happens to bump the cursor.
    await logChange(tx, userId, 'workouts', id)
    return { id, created: existing.length === 0 }
  })
}
