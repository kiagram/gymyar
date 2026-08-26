/* Attachments: the rows that know where the bytes are.
 *
 * The lifecycle is the thing to hold in your head, and it is three states rather than two:
 *
 *   reserve()  → a row with no bytes yet, and the key those bytes will land under
 *   finish()   → the bytes landed, here is how many; the row is now readable
 *   remove()   → gone from every screen; the sweeper still has work to do
 *
 * Why the row is written before the bytes is in `migrations/004_attachments.sql` and is worth
 * reading once: `packages/storage` deliberately cannot list itself, so an object written before
 * its row is an object nothing can ever find again. Reserving first means every byte on the
 * volume has a row that names it — including the bytes of uploads that died halfway, which is
 * exactly the set `abandoned()` exists to hand to the sweeper.
 *
 * Nothing here goes through `logChange`. Attachments are not a syncable table: the bytes are
 * not on the phone, and a synced row would promise a video that cannot be played offline.
 */
import { db } from './index.js'

/** Everything a screen renders, and nothing that only the sweeper cares about. */
const PUBLIC = ['id', 'subject', 'kind', 'mime', 'bytes', 'caption', 'created_at',
  'workout_id', 'exercise_id', 'on_date', 'message_id']

/**
 * The shape that leaves this module for a client.
 *
 * `storage_key` and `owner_id` are not in it. The key is how the server finds the bytes, and
 * a client that has one has something it can put in a URL — the only URL it should ever hold
 * is a signed one with minutes on it, minted per read by whoever checked the permission.
 */
export const publicView = row => {
  if (!row) return null
  const out = {}
  for (const k of PUBLIC) if (row[k] !== null && row[k] !== undefined) out[k] = row[k]
  // Postgres hands back a `date` for on_date; a screen wants the day, not a local midnight.
  if (row.on_date instanceof Date) out.on_date = row.on_date.toISOString().slice(0, 10)
  return out
}

/* ------------------------------------------------------------- writing ---- */

/**
 * Claim a row and a key for an upload that has not happened yet.
 *
 * The id is minted by the caller rather than by the database, because the storage key is
 * derived from it and the key has to exist before the row does — `buildKey` needs the id, and
 * `insert … returning id` would hand it back one step too late.
 */
export async function reserve(
  { id, ownerId, subject, kind, mime, storageKey, workoutId = null, exerciseId = null,
    onDate = null, messageId = null, caption = null },
  s = db()
) {
  const [row] = await s`
    insert into attachments
      (id, owner_id, subject, kind, mime, storage_key, workout_id, exercise_id, on_date,
       message_id, caption)
    values
      (${id}, ${ownerId}, ${subject}, ${kind}, ${mime}, ${storageKey}, ${workoutId},
       ${exerciseId}, ${onDate}, ${messageId}, ${caption})
    returning *`
  return row
}

/** The bytes landed. This is the write that makes the row visible to every read below. */
export async function finish({ id, bytes }, s = db()) {
  const [row] = await s`
    update attachments set bytes = ${bytes}, uploaded_at = now()
    where id = ${id} and uploaded_at is null and deleted_at is null
    returning *`
  return row || null
}

/**
 * Take it off every screen.
 *
 * A flag rather than a `delete`, so that the row stops being readable at the speed of one
 * update rather than at the speed of whatever the storage volume is doing. The bytes and the
 * row itself go in `purge()`, driven by the sweeper.
 *
 * Scoped to the owner in the same statement rather than checked first: "delete this if it is
 * yours" is one question, and asking it as two is how a race becomes somebody else's file.
 */
export async function remove({ id, ownerId }, s = db()) {
  const [row] = await s`
    update attachments set deleted_at = now()
    where id = ${id} and owner_id = ${ownerId} and deleted_at is null
    returning *`
  return row || null
}

/* ------------------------------------------------------------- reading ---- */

export const byId = (id, s = db()) =>
  s`select * from attachments where id = ${id} and deleted_at is null`.then(r => r[0] || null)

/** One session's form checks, in the order the exercises were done. */
export const forWorkout = (ownerId, workoutId, s = db()) => s`
  select * from attachments
  where owner_id = ${ownerId} and subject = 'form_check' and workout_id = ${workoutId}
    and uploaded_at is not null and deleted_at is null
  order by created_at`

/**
 * Form checks across several sessions at once.
 *
 * The history screen and the coach's client view both render a list of workouts and need to
 * know which of them have a video, which is N questions asked as one. Returned as a Map keyed
 * by workout id, because every caller is about to do a lookup per row.
 */
export async function forWorkouts(ownerId, workoutIds, s = db()) {
  if (!workoutIds?.length) return new Map()
  const rows = await s`
    select * from attachments
    where owner_id = ${ownerId} and subject = 'form_check' and workout_id = any(${workoutIds})
      and uploaded_at is not null and deleted_at is null
    order by created_at`
  const out = new Map()
  for (const r of rows) {
    if (!out.has(r.workout_id)) out.set(r.workout_id, [])
    out.get(r.workout_id).push(r)
  }
  return out
}

/** Progress photos, newest first — which is the order the screen shows them in. */
export const progressFor = (ownerId, { limit = 60 } = {}, s = db()) => s`
  select * from attachments
  where owner_id = ${ownerId} and subject = 'progress'
    and uploaded_at is not null and deleted_at is null
  order by on_date desc, created_at desc
  limit ${limit}`

/** Everything attached to the messages in a thread, as a Map keyed by message id. */
export async function forMessages(messageIds, s = db()) {
  if (!messageIds?.length) return new Map()
  const rows = await s`
    select * from attachments
    where subject = 'message' and message_id = any(${messageIds}::uuid[])
      and uploaded_at is not null and deleted_at is null
    order by created_at`
  const out = new Map()
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, [])
    out.get(r.message_id).push(r)
  }
  return out
}

/**
 * What this account is currently holding, in bytes and in files.
 *
 * Counts reserved-but-unfinished rows as files and not as bytes, which is the only honest
 * answer while an upload is in flight — and it means a client cannot open a thousand
 * simultaneous uploads to slip under a byte quota that has not been charged yet.
 */
export async function usageFor(ownerId, s = db()) {
  const [row] = await s`
    select coalesce(sum(bytes), 0)::bigint as bytes, count(*)::int as files
    from attachments where owner_id = ${ownerId} and deleted_at is null`
  return { bytes: Number(row.bytes), files: row.files }
}

/* ------------------------------------------------------------ sweeping ---- */

/**
 * Rows somebody deleted, whose bytes are still on the volume.
 *
 * The sweeper's first list. Ordered oldest first so a backlog drains in the order it formed
 * rather than starving whatever happens to sort last.
 */
export const deleted = ({ limit = 200 } = {}, s = db()) => s`
  select * from attachments where deleted_at is not null
  order by deleted_at limit ${limit}`

/**
 * Uploads that never finished.
 *
 * A row reserved and then abandoned — the connection dropped, the phone locked, the process
 * restarted mid-stream. Its bytes may be on the volume, partly or not at all, and the delete
 * is idempotent either way.
 *
 * The age matters: this must never catch an upload that is still arriving. A minute is not the
 * ceiling on how long a 60 MB video takes on a bad connection, so the default is generous
 * enough that the only rows it finds are genuinely dead.
 */
export const abandoned = ({ minutes = 60, limit = 200 } = {}, s = db()) => s`
  select * from attachments
  where uploaded_at is null and deleted_at is null
    and created_at < now() - ${minutes + ' minutes'}::interval
  order by created_at limit ${limit}`

/**
 * Delete the row. Its key is tombstoned by the trigger on the way out.
 *
 * Which is what makes this safe to do before the bytes are gone, and why it does not need to
 * know whether they are: `orphaned_media` now holds the key, and it holds it whether the row
 * left through here, through a deleted account, or through somebody at a psql prompt.
 */
export async function purge(id, s = db()) {
  const rows = await s`delete from attachments where id = ${id} returning id`
  return rows.length > 0
}

/**
 * Keys whose rows are gone and whose bytes may not be.
 *
 * The sweeper's actual work list. Everything else it looks at is a row it is about to turn
 * into one of these — including, crucially, the ones nothing in this application deleted: an
 * account removed by an operator takes its attachment rows with it by cascade, and without
 * this table it would take the only record of its files too.
 */
export const orphaned = ({ limit = 500 } = {}, s = db()) => s`
  select storage_key, at from orphaned_media order by at limit ${limit}`

/** The bytes are gone; stop remembering them. */
export async function forget(storageKey, s = db()) {
  const rows = await s`
    delete from orphaned_media where storage_key = ${storageKey} returning storage_key`
  return rows.length > 0
}

/**
 * Live rows whose bytes may not be there, oldest first.
 *
 * The reconciler's input, and the reason `stat` is in the storage interface at all: this
 * answers "the database says these exist" and only the volume can answer the other half. A
 * restore that brought back a database and an older media archive is exactly this list.
 */
export const claimed = ({ limit = 500, after = null } = {}, s = db()) => s`
  select * from attachments
  where uploaded_at is not null and deleted_at is null
    ${after ? s`and created_at > ${after}` : s``}
  order by created_at limit ${limit}`
