/* The thing that actually deletes files — and, since it is the one periodic job this process
 * has, the spent password-reset links too.
 *
 * Deleting an attachment sets `deleted_at` and returns — the row leaves every screen at the
 * speed of one update, which is the right thing for the person who pressed the button. It is
 * not the whole job. Until something removes the bytes, "delete" means "hidden", and the
 * difference between those two words is the difference between a product that keeps a promise
 * about a photo of somebody's body and one that does not.
 *
 * So this runs, and it runs in the API process rather than in a cron the operator has to set
 * up. A self-hosted instance is `docker compose up` and nothing else; a sweeper that needs a
 * second moving part is a sweeper that is not running on most of the instances that exist.
 *
 * ## Two phases
 *
 * **Retire rows.** `deleted()` is what somebody removed; `abandoned()` is an upload that died
 * between reserving its row and finishing it — the connection dropped, the phone locked, the
 * process restarted mid-stream. Both are deleted, and deleting an attachment row tombstones its
 * storage key in `orphaned_media` by trigger.
 *
 * **Delete bytes.** Everything in `orphaned_media`, by key, then forget the key.
 *
 * The tombstone is what makes the row safe to remove first. Without it the order had to be
 * bytes-then-row, because `packages/storage` cannot list itself and a row removed before its
 * bytes would leave them unfindable forever. That was only ever true for deletions this code
 * performs — and the ones it does not are the dangerous ones. `attachments.owner_id` cascades,
 * so removing a user erases every row they had without this process being involved at all, and
 * "we deleted your account but kept your photographs" is the worst version of this bug there
 * is. The trigger fires for that cascade exactly as it does for a sweep.
 *
 * So the second phase is not "clean up after the first". It is the whole job, and the first
 * phase is one of several things that feed it.
 *
 * ## Running twice is fine, and worth keeping fine
 *
 * `storage.delete()` answers false for an object that is already gone rather than throwing,
 * and `purge()` deletes by primary key. Two API containers sweeping the same backlog do the
 * same work twice and reach the same state, which is what makes it safe to scale the process
 * out without electing a leader.
 */
import { deleted, abandoned, purge, orphaned, forget } from '@gymyar/db/attachments.js'
import { purgeDeadResets } from '@gymyar/db/passwords.js'
import { purgeDeadCodes } from '@gymyar/db/codes.js'
import { storage } from './media.js'

/** How often the timer fires. Long: the work is small and none of it is urgent to the minute. */
const EVERY_MS = 15 * 60 * 1000

/**
 * One pass. Returns what it did, which is what makes it testable without a clock.
 *
 * Errors are counted rather than thrown. A volume that is full, read-only or briefly missing
 * is a reason to try again in fifteen minutes, not a reason to take the process down — and a
 * single unreadable key must not stop the rest of the backlog from draining behind it.
 */
export async function sweepOnce({ log = null, limit = 200, abandonedAfterMinutes = 60 } = {}) {
  const store = storage()
  let purged = 0, files = 0, failed = 0

  // Phase one: rows that have finished being rows. Each delete tombstones its key.
  const rows = [
    ...await deleted({ limit }),
    ...await abandoned({ minutes: abandonedAfterMinutes, limit })
  ]
  for (const row of rows) {
    try { if (await purge(row.id)) purged++ }
    catch (err) {
      failed++
      log?.warn?.({ err, attachment: row.id }, 'could not retire an attachment row')
    }
  }

  /* Phase two: the keys, wherever they came from — this sweep, an earlier one that could not
   * reach the volume, or a cascade nothing here was party to.
   *
   * `delete` answers false for an object that is already gone rather than throwing, so a key
   * whose bytes never landed is forgotten just the same. Only a real failure keeps a key on the
   * list, which is what makes an unreachable volume a delay rather than a leak. */
  const keys = await orphaned({ limit: limit * 2 })
  for (const { storage_key: key } of keys) {
    try {
      if (await store.delete(key)) files++
      await forget(key)
    } catch (err) {
      failed++
      log?.warn?.({ err, key }, 'could not delete stored bytes')
    }
  }

  /* Spent and expired reset links, a day after they stopped working.
   *
   * Not media, and it is here anyway rather than in a timer of its own — this is the process's
   * one periodic job, and a second one would be a second thing to remember to start. Counted
   * separately so the sweep's own numbers stay about bytes.
   */
  let resets = 0
  try { resets = await purgeDeadResets() }
  catch (err) { failed++; log?.warn?.({ err }, 'could not purge spent password resets') }

  /* And spent one-time codes, on the same day's delay and for one extra reason: the resend
   * cooldown and the per-number daily ceiling are counted off these rows, so sweeping them
   * eagerly would hand somebody a fresh allowance of text messages every fifteen minutes. */
  let codes = 0
  try { codes = await purgeDeadCodes() }
  catch (err) { failed++; log?.warn?.({ err }, 'could not purge spent verification codes') }

  if (log && (files || purged || resets || codes || failed)) {
    log.info({ files, purged, resets, codes, failed }, 'sweep')
  }
  return { files, purged, resets, codes, failed, considered: rows.length + keys.length }
}

/**
 * Start the timer and return a function that stops it.
 *
 * `unref()` so the sweeper never holds the process open: a container being shut down should
 * shut down, and there is nothing here worth finishing on the way out — whatever is left is
 * still in the two lists next time.
 *
 * The first pass is immediate rather than one interval away, because the most likely backlog
 * at boot is whatever the last process was in the middle of when it stopped.
 */
export function startSweeper({ log = null, every = EVERY_MS } = {}) {
  let running = false
  const pass = async () => {
    if (running) return                  // a slow pass must not overlap the next tick
    running = true
    try { await sweepOnce({ log }) } catch (err) { log?.error?.({ err }, 'media sweep failed') } finally { running = false }
  }
  pass()
  const timer = setInterval(pass, every)
  timer.unref?.()
  return () => clearInterval(timer)
}
