/* The one endpoint that answers without an account.
 *
 * The project site is served from the same origin as the app (nginx puts the site at `/` and
 * the app at `/app/`), and its numbers used to be typed into the HTML by hand. This is where
 * they come from instead: the instance counting itself.
 *
 * ## What may leave here
 *
 * Counts and one sum. No id, no name, no email, no row — and nothing that narrows to a person.
 * That rule is the whole reason this file is separate from the routes that need a session:
 * there is no `requireUser` in it, so anything added below is public by construction and has
 * to be read as such. A per-user figure, a leaderboard, a "most popular exercise" — none of
 * those belong here, however aggregate they look, because a small instance is a small crowd
 * to hide in.
 *
 * It is also switchable. A household instance may simply not want to publish how few people
 * are on it, so `PUBLIC_STATS=off` makes the route not exist rather than answer with zeroes.
 *
 * ## Why it is cached in this process
 *
 * The query is six aggregates, two of them across every set ever logged — cheap on a small
 * instance and not free on a large one, and the answer is the same for every visitor. So it
 * is computed at most once every five minutes and handed out from memory in between, which
 * is also what makes it safe to leave off the rate limiter's ledger: the cost of the ten
 * thousandth request in a minute is a property lookup.
 */
import { db } from '@gymyar/db'
import { config } from '../config.js'

/** How long a computed answer is reused, in milliseconds. Also sent as `max-age`. */
export const TTL_MS = 5 * 60_000

let cache = null   // { at: epochMs, body: {...} }

/**
 * Count the instance. Exported so the test can call it without going through HTTP.
 *
 * Warm-up sets are excluded from both the set count and the volume: they are real rows and
 * they are not work anybody did, and a number on a landing page that counts them is a number
 * that flatters itself. Unfinished sessions are excluded for the same reason — a workout
 * opened and abandoned is not a session logged.
 */
export async function instanceStats() {
  const s = db()
  const [row] = await s`
    select
      (select count(*)::int from users
         where disabled_at is null)                                    as athletes,
      (select count(*)::int from users
         where disabled_at is null and is_coach)                       as coaches,
      (select count(*)::int from workouts
         where deleted_at is null and finished_at is not null)         as workouts,
      (select count(*)::int from workout_sets s
         join workouts w on w.id = s.workout_id
         where w.deleted_at is null and s.done and not s.is_warmup)    as sets,
      -- Weight times reps, over the sets that have both. A plank has neither and a cardio row
      -- has a distance; both are real training and neither is tonnage, so they contribute
      -- nothing here rather than a zero that would look like a bug in the sum.
      (select coalesce(sum(s.weight_kg * s.reps), 0)::bigint from workout_sets s
         join workouts w on w.id = s.workout_id
         where w.deleted_at is null and s.done and not s.is_warmup
           and s.weight_kg is not null and s.reps is not null)         as volume_kg,
      (select count(*)::int from exercises
         where deleted_at is null and owner_id is null)                as exercises`
  return {
    athletes: row.athletes,
    coaches: row.coaches,
    workouts: row.workouts,
    sets: row.sets,
    // bigint arrives as a string from the driver. Well inside a double at any plausible size:
    // 2^53 kg is nine billion tonnes.
    volumeKg: Number(row.volume_kg),
    exercises: row.exercises
  }
}

export default async function publicRoutes(app, { enabled = config.publicStats } = {}) {
  // Not a guard inside the handler: off means the route was never registered, so the answer
  // is a 404 from the router rather than a 403 that confirms there is something here.
  if (!enabled) return

  app.get('/api/public/stats', async (req, reply) => {
    const now = Date.now()
    if (!cache || now - cache.at > TTL_MS) {
      cache = { at: now, body: { stats: await instanceStats(), generatedAt: new Date(now).toISOString() } }
    }
    // The one response from this API that a shared cache may keep, because it is the one that
    // is the same for everybody. `app.js` leaves this header alone; everything else is no-store.
    reply.header('Cache-Control', `public, max-age=${Math.round(TTL_MS / 1000)}`)
    return cache.body
  })
}

/** Drop the memoised answer. For tests, which change the database between assertions. */
export const _resetStatsCache = () => { cache = null }
