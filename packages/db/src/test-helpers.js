import { connect, migrate, db, close } from './index.js'
import { seedExercises } from './seed-exercises.js'

export const TEST_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

let ready = false
/** Returns the postgres handle. Always await it inside a hook body rather than passing this
 *  function to `beforeAll` directly — the handle is callable, and a hook that returns a
 *  function has that function invoked as teardown. */
export async function setupDb() {
  if (!ready) {
    connect(TEST_URL, { max: 4 })
    await migrate()
    await seedExercises()
    ready = true
  }
  return db()
}

/** Wipe user data between tests, leaving the exercise library and the schema alone.
 *
 * DELETE, not `truncate users cascade`. TRUNCATE CASCADE truncates every table with a foreign
 * key to users — `exercises` included — and that table holds the 1,324-row shared library, which
 * has no owner and is not test data. DELETE follows `on delete cascade` instead, so a user's own
 * exercises go and the library stays. */
export async function truncateUsers() {
  await db()`delete from users`
  /* `orphaned_media` has no foreign key to anything — that is the whole point of it, so that a
   * deleted account cannot take the record of its files with it. Which means the cascade above
   * does not clear it, and a test that sweeps would otherwise find every key every earlier test
   * left behind. */
  await db()`delete from orphaned_media`
  /* Same shape of problem, same reason: a `phone_codes` row is about a *number*, not a user —
   * it is written before there is an account for it to reference — so nothing cascades it away
   * and a resend cooldown from one test would land on the next one asking for the same number. */
  await db()`delete from phone_codes`
}

export async function teardownDb() { await close(); ready = false }
