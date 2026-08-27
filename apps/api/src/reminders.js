/* The notifications nobody caused.
 *
 * Everything in `notify.js` announces something a person just did — a message sent, a proposal
 * answered — and rides on that request. These are the other half: a check-in is due, a week has
 * gone quiet. Nothing happened, which is exactly why somebody needs telling.
 *
 * ## Its own timer, next to the sweeper's and not inside it
 *
 * The sweeper says a second periodic job would be a second thing to remember to start, and it is
 * right about password resets, which are bytes-adjacent housekeeping. This is not housekeeping.
 * Deleting files and messaging people fail differently, matter differently and belong in
 * different log lines — and this one is meaningless on the single-user self-hosted instance the
 * sweeper still has to run on. Two timers, both started in the same three lines of server.js.
 *
 * ## The hour is the recipient's, not the server's
 *
 * A reminder at six in the evening is useful; the same reminder at three in the morning is an
 * uninstall. So each candidate carries the timezone their app reported, and the pass asks what
 * hour it is *there* before deciding. Somebody whose timezone is unknown gets the instance's
 * own, which for a product whose users are nearly all in one country is a good guess and is
 * still a guess — stated here rather than hidden.
 *
 * ## Sending twice is the failure mode, so the claim comes first
 *
 * The tick runs every fifteen minutes and the target hour lasts sixty, so every candidate comes
 * up four times. `claim()` is what makes only the first of those do anything, and it is also
 * what makes two API containers safe. It is taken *before* the send and given back if the send
 * throws, so a crash between the two costs a retry rather than a silent miss.
 */
import {
  claim, unclaim, checkinCandidates, coachDigests, purgeOldSends
} from '@gymyar/db/reminders.js'
import { checkinDateFor, weekStartsFor, localTZ } from '@gymyar/domain'
import { notify, wants } from './notify.js'

/** How often the timer fires. The same fifteen minutes the sweeper uses, for the same reasons. */
const EVERY_MS = 15 * 60 * 1000

/* When each kind goes out, in the recipient's own hour.
 *
 * Evening for the client's check-in, because it asks about a week and a week is not over at
 * breakfast. Morning for the coach's digest, because it is a list of people to think about
 * today. Neither is a setting: a per-user hour is a preference nobody would ever open the
 * screen to set, and two of them is a scheduling problem rather than a product. */
const HOURS = { checkin_due: 18, coach_digest: 8 }

/** What hour it is where somebody is, or null if their timezone is not one Intl knows. */
export function hourIn(tz, now = new Date()) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: 'numeric', hour12: false
    }).format(now))
  } catch {
    return null
  }
}

/** The calendar day where somebody is — which is not the server's day, either side of midnight. */
export function dayIn(tz, now = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now)
  } catch {
    return now.toISOString().slice(0, 10)
  }
}

/**
 * Which local date this person's current check-in is filed under.
 *
 * The same arithmetic the client's form does, so the reminder is about the row they would open
 * — and it runs in *their* week, which under fa-IR starts on Saturday. Getting this wrong sends
 * somebody a reminder for a check-in they filled in on Saturday.
 */
export function dueDateFor({ tz, locale, weekday }, now = new Date()) {
  const today = dayIn(tz, now)
  const start = new Date(today + 'T12:00:00')
  const first = weekStartsFor(locale)
  start.setDate(start.getDate() - ((start.getDay() - first + 7) % 7))
  return checkinDateFor(start, weekday).toISOString().slice(0, 10)
}

/**
 * One pass. Returns what it did, which is what makes it testable without a clock or a timer.
 *
 * `now` and `send` are injectable for the same reason: a test should be able to say "it is six
 * in the evening in Tehran" and see what happens, without waiting for six in the evening.
 */
export async function remindOnce({
  log = null, now = new Date(), send = notify, fallbackTz = localTZ()
} = {}) {
  let checkins = 0
  let digests = 0
  let failed = 0

  const at = async (kind, userId, tz, fireKey, args) => {
    if (hourIn(tz, now) !== HOURS[kind]) return false
    /* Before the claim, not after. `notify` checks this too and would refuse to send — but by
     * then the claim is spent, so the row is written, the count says one went out, and nothing
     * did. Asking first costs one read and keeps `notifications_sent` a record of decisions
     * rather than of intentions. */
    if (!(await wants(userId, kind))) return false
    if (!(await claim(userId, kind, fireKey))) return false
    try {
      await send(userId, kind, args)
      return true
    } catch (err) {
      /* The claim goes back. A send that threw has not been delivered, and leaving the row
       * behind would mean nobody ever tries again — a permanent silence caused by one bad
       * fifteen minutes. */
      await unclaim(userId, kind, fireKey).catch(() => {})
      failed++
      log?.warn?.({ err, userId, kind }, 'could not send a scheduled notification')
      return false
    }
  }

  try {
    for (const c of await checkinCandidates()) {
      const tz = c.tz || fallbackTz
      const due = dueDateFor({ tz: c.tz || fallbackTz, locale: c.locale, weekday: c.weekday }, now)
      // Already answered for this week — the row they would open is filled in.
      if (c.last_on && c.last_on >= due) continue
      // Not due yet. The reminder is for the day it is asked for, not the days before it.
      if (dayIn(tz, now) < due) continue
      if (await at('checkin_due', c.user_id, tz, due, {})) checkins++
    }
  } catch (err) {
    failed++
    log?.warn?.({ err }, 'could not read check-in reminders')
  }

  try {
    for (const d of await coachDigests()) {
      // Nothing to say is not a notification. A daily push that reads "0 and 0" is the reason
      // people turn digests off.
      if (!d.answered && !d.quiet) continue
      const tz = d.tz || fallbackTz
      if (await at('coach_digest', d.user_id, tz, dayIn(tz, now), {
        answered: d.answered, quiet: d.quiet
      })) digests++
    }
  } catch (err) {
    failed++
    log?.warn?.({ err }, 'could not read coach digests')
  }

  /* Old claims, once they are old enough that nothing could fire them again. Here rather than in
   * the sweeper because this is the only thing that writes them, and a table's own janitor
   * belongs with the code that fills it. */
  let forgotten = 0
  try { forgotten = await purgeOldSends() }
  catch (err) { failed++; log?.warn?.({ err }, 'could not forget old sends') }

  if (log && (checkins || digests || failed)) {
    log.info({ checkins, digests, forgotten, failed }, 'reminders')
  }
  return { checkins, digests, forgotten, failed }
}

/**
 * Start the timer and return a function that stops it.
 *
 * `unref()` so this never holds the process open — a container being shut down should shut down,
 * and a reminder not sent at 18:00 is sent at 18:15 by whoever is still running.
 */
export function startReminders({ log = null, everyMs = EVERY_MS } = {}) {
  const timer = setInterval(() => {
    remindOnce({ log }).catch(err => log?.error?.({ err }, 'reminder pass failed'))
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
