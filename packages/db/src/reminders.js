/* Who is owed a scheduled notification, and the claim that stops it being sent twice.
 *
 * The queries here answer one question each and answer it for everybody at once, because the
 * caller is a timer with no user in front of it — a pass that walked the roster client by client
 * would be one round trip per person every fifteen minutes, forever, on an instance where almost
 * nobody is owed anything.
 *
 * Everything returns the recipient's locale and timezone with the rest of it. Both are needed
 * before a decision can be made — the locale to write the words, the timezone to know whether it
 * is a reasonable hour where they are — and fetching them per candidate afterwards would undo
 * the point of asking once.
 */
import { db } from './index.js'

/**
 * Claim the right to send one notification, atomically.
 *
 * True means this process won it. False means another one already has, which on a single
 * container means it has already been sent and on two means the other got there first — and
 * both call for the same thing, which is doing nothing.
 *
 * The insert *is* the claim. A `select` first would be a read-then-write that two containers
 * can both pass in the same millisecond; a primary key cannot lose that race. See migration 009.
 */
export async function claim(userId, kind, fireKey, s = db()) {
  const rows = await s`
    insert into notifications_sent (user_id, kind, fire_key)
    values (${userId}, ${kind}, ${fireKey})
    on conflict do nothing
    returning user_id`
  return rows.length > 0
}

/** Give a claim back, so a send that failed before it went out can be retried next tick. */
export const unclaim = (userId, kind, fireKey, s = db()) => s`
  delete from notifications_sent
  where user_id = ${userId} and kind = ${kind} and fire_key = ${fireKey}`

/**
 * Clients with a check-in scheduled, and whether they have answered this week.
 *
 * `last_on` is their most recent *submitted* answer, as a calendar-day string — the caller
 * works out which week that belongs to, because which day a week starts on is the reader's
 * locale and this query has no business deciding it. Same `to_char` reasoning as everywhere
 * else: a `date` becomes a Date at UTC midnight and reads as the day before west of Greenwich.
 *
 * Only active links, only clients who granted `checkins`, and only where the template is still
 * live. A coach who archived their questions is no longer asking them, and reminding somebody
 * about a form nobody will read is worse than silence.
 */
export const checkinCandidates = (s = db()) => s`
  select l.client_id            as user_id,
         u.locale,
         sc.weekday,
         us.settings->'reminder'->>'tz' as tz,
         (select to_char(max(c.on_date), 'YYYY-MM-DD') from checkins c
           where c.user_id = l.client_id and c.deleted_at is null
             and c.submitted_at is not null) as last_on
  from checkin_schedules sc
  join coaching_links l on l.id = sc.link_id and l.status = 'active'
    and 'checkins' = any(l.scopes)
  join checkin_templates t on t.id = sc.template_id and t.archived_at is null
  join users u on u.id = l.client_id and u.disabled_at is null
  left join user_settings us on us.user_id = l.client_id`

/**
 * What a coach would want to hear about since yesterday, one row per coach.
 *
 * Counted in SQL rather than assembled in Node for the same reason `roster` counts sessions
 * there: this runs for every coach on the instance, and the alternative is pulling every client
 * of every coach into memory to count two things.
 *
 * `quiet` is deliberately not "has not trained in N days" for its own sake — it is the number a
 * coach is being told about, and a coach with eighty clients needs a number rather than a list.
 * Fourteen days because a week off is a week off, and a fortnight is when somebody has stopped.
 */
export const coachDigests = ({ quietDays = 14 } = {}, s = db()) => s`
  select l.coach_id as user_id,
         u.locale,
         us.settings->'reminder'->>'tz' as tz,
         count(*) filter (
           where exists (
             select 1 from checkins c
             where c.user_id = l.client_id and c.deleted_at is null
               and c.submitted_at > now() - interval '1 day')
         )::int as answered,
         count(*) filter (
           where not exists (
             select 1 from workouts w
             where w.user_id = l.client_id and w.deleted_at is null
               and w.finished_at > now() - ${quietDays}::int * interval '1 day')
         )::int as quiet
  from coaching_links l
  join users u on u.id = l.coach_id and u.disabled_at is null
  left join user_settings us on us.user_id = l.coach_id
  where l.status = 'active' and l.client_id is not null
  group by l.coach_id, u.locale, us.settings`

/** Forget sends old enough that nothing could send them again anyway. */
export const purgeOldSends = (days = 60, s = db()) => s`
  delete from notifications_sent where sent_at < now() - ${days}::int * interval '1 day'`
  .then(r => r.count ?? 0)
