/* @gymbuddy/db — connection, migrations and the write helpers that keep the change log honest.
 *
 * Everything that mutates a syncable row goes through `logged()`. That is not a style rule:
 * a write that skips the change log is invisible to every client that is already synced, and
 * the bug shows up days later as "my phone never got that workout". Making it the only
 * ergonomic way to write is the point.
 */
import postgres from 'postgres'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_DIR = path.join(HERE, '..', 'migrations')

let sql = null

export function connect(url = process.env.DATABASE_URL, opts = {}) {
  if (!url) throw new Error('DATABASE_URL is not set')
  sql = postgres(url, {
    max: opts.max ?? 10,
    onnotice: () => {},          // migrations are chatty about "already exists"; we check ourselves
    transform: { undefined: null },
    ...opts
  })
  return sql
}

export function db() {
  if (!sql) connect()
  return sql
}

export async function close() {
  if (sql) { await sql.end({ timeout: 5 }); sql = null }
}

/* ---------- migrations ---------- */

export async function migrate({ log = () => {} } = {}) {
  const s = db()
  await s`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now()
  )`
  const applied = new Set((await s`select name from schema_migrations`).map(r => r.name))
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort()
  let ran = 0
  for (const f of files) {
    if (applied.has(f)) continue
    const body = await readFile(path.join(MIGRATIONS_DIR, f), 'utf8')
    // Each migration is one transaction: a half-applied schema is worse than none.
    await s.begin(async tx => {
      await tx.unsafe(body)
      await tx`insert into schema_migrations (name) values (${f})`
    })
    log(`applied ${f}`)
    ran++
  }
  return { ran, total: files.length }
}

export async function reset() {
  const s = db()
  await s`drop schema public cascade`
  await s`create schema public`
}

/* ---------- change-logged writes ---------- */

/** Tables whose rows belong to a user and take part in sync. */
export const SYNC_TABLES = [
  'routines', 'workouts', 'bodyweight_entries', 'exercises',
  'week_plan', 'day_overrides', 'user_settings'
]

/**
 * Record that a row changed, and return the cursor it landed on.
 * Call inside the same transaction as the write itself — a change log entry for a write
 * that rolled back is a client pulling a row that does not exist.
 */
export async function logChange(tx, userId, table, rowId, op = 'upsert') {
  const [{ log_change: cursor }] = await tx`
    select log_change(${userId}::uuid, ${table}, ${String(rowId)}, ${op})`
  return cursor
}

/** Current sync cursor for a user (0 before their first write). */
export async function cursorFor(userId, s = db()) {
  const rows = await s`select value from sync_cursor where user_id = ${userId}`
  return rows.length ? Number(rows[0].value) : 0
}

export { postgres }
