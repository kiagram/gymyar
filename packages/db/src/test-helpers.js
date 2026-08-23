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

/** Wipe user data between tests, leaving the exercise library and the schema alone. */
export async function truncateUsers() {
  const s = db()
  await s`truncate users cascade`
  await s`delete from exercises where owner_id is not null`
}

export async function teardownDb() { await close(); ready = false }
