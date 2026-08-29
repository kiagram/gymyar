/* Check-ins, from the coach's side.
 *
 * The client's side is not here and never will be: an answer is the client's own row, written
 * through `push` in sync.js like every other row they hold. What lives here is everything a
 * coach owns — the questions, which client is asked them, and reading the replies through the
 * scope that permits it.
 *
 * That split is the same one `coaching.js` holds for programmes, and for the same reason: there
 * is exactly one writer per row. A coach who could write an answer could answer for somebody,
 * and "my coach filled in my check-in" is not a sentence this product should be able to produce.
 */
import { normaliseFields, fieldsOf } from '@gymyar/domain'
import { db } from './index.js'
import { requireScope, coachesOf } from './coaching.js'

/* ----------------------------------------------------------- templates ---- */

/**
 * Create or update a coach's template.
 *
 * Fields go through the domain on the way in, so the form a client is shown and the answers the
 * server will accept are shaped by one piece of code rather than two that agree until they do
 * not. An update is scoped to the owner in the `where`, so a wrong id is a write that touches
 * nothing rather than somebody else's template.
 */
export async function saveTemplate({ coachId, id = null, title, fields }, s = db()) {
  const clean = normaliseFields(fields)
  const name = String(title ?? '').trim().slice(0, 120) || 'Weekly check-in'

  if (!id) {
    const [row] = await s`
      insert into checkin_templates (coach_id, title, fields)
      values (${coachId}, ${name}, ${s.json(clean)})
      returning *`
    return row
  }

  const [row] = await s`
    update checkin_templates
    set title = ${name}, fields = ${s.json(clean)}, updated_at = now()
    where id = ${id} and coach_id = ${coachId}
    returning *`
  if (!row) throw Object.assign(new Error('template not found'), { status: 404 })
  return row
}

export const templatesOf = (coachId, s = db()) => s`
  select * from checkin_templates
  where coach_id = ${coachId} and archived_at is null
  order by created_at`

/**
 * Retire a template without deleting it.
 *
 * Every answer ever given to it points here, and an answer is only readable next to the question
 * it answered. Deleting the row would leave months of replies whose `template_id` has gone to
 * null — which the schema allows, because it has to survive an account being deleted, but which
 * loses the wording. Archiving costs nothing and keeps it.
 */
export async function archiveTemplate({ coachId, id }, s = db()) {
  const [row] = await s`
    update checkin_templates set archived_at = now(), updated_at = now()
    where id = ${id} and coach_id = ${coachId} and archived_at is null
    returning *`
  return row ?? null
}

/* ----------------------------------------------------------- schedules ---- */

/**
 * Put a template on a client, due on a given weekday.
 *
 * One row per link, so scheduling again replaces rather than stacks. Both the link and the
 * template are checked to belong to this coach in the same statement that writes — a schedule
 * assembled from somebody else's link id would be a coach asking questions of a stranger.
 */
export async function scheduleCheckin({ coachId, linkId, templateId, weekday }, s = db()) {
  const day = Number(weekday)
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw Object.assign(new Error('weekday must be 0-6'), { status: 400 })
  }

  const [row] = await s`
    insert into checkin_schedules (link_id, template_id, weekday)
    select l.id, t.id, ${day}
    from coaching_links l
    join checkin_templates t on t.id = ${templateId} and t.coach_id = ${coachId}
    where l.id = ${linkId} and l.coach_id = ${coachId} and l.status in ('active','paused')
      and t.archived_at is null
    on conflict (link_id) do update set
      template_id = excluded.template_id, weekday = excluded.weekday, updated_at = now()
    returning *`
  if (!row) throw Object.assign(new Error('not your client, or no such template'), { status: 403 })
  return row
}

export async function unscheduleCheckin({ coachId, linkId }, s = db()) {
  const [row] = await s`
    delete from checkin_schedules
    using coaching_links l
    where checkin_schedules.link_id = l.id and l.id = ${linkId} and l.coach_id = ${coachId}
    returning checkin_schedules.*`
  return row ?? null
}

/** The schedule on a link, with the template attached — what the client's form is built from. */
export const scheduleFor = (linkId, s = db()) => s`
  select sc.*, t.title, t.fields, t.archived_at
  from checkin_schedules sc join checkin_templates t on t.id = sc.template_id
  where sc.link_id = ${linkId}`.then(r => r[0] ?? null)

/**
 * Which questions this person is being asked, and by whom.
 *
 * One per active coach who has scheduled something, newest link first, empty for everybody
 * else — and everybody else is most people, who answer the built-in set that is not a row
 * anywhere. An archived template is not returned: it has stopped being asked, while the answers
 * already given to it keep pointing at it, which is why it was archived rather than deleted.
 *
 * This is shared rather than inlined into the form route because the review reads answers
 * against the fields they were given to, and a second copy of "which template is this" is a
 * second thing to keep in step with archiving, scoping and scheduling.
 */
export async function formsFor(clientId, email, s = db()) {
  const links = await coachesOf(clientId, email, s)
  const out = []
  for (const link of links) {
    if (link.status !== 'active' || !link.scopes?.includes('checkins')) continue
    const sc = await scheduleFor(link.id, s)
    if (!sc || sc.archived_at) continue
    out.push({
      linkId: link.id,
      coachName: link.coach_name,
      templateId: sc.template_id,
      title: sc.title,
      weekday: sc.weekday,
      fields: fieldsOf(sc)
    })
  }
  return out
}

/* ------------------------------------------------------------- reading ---- */

/**
 * A client's check-ins, for their coach.
 *
 * Gated on `checkins` and nothing else. Not on who wrote the template and not on whether this
 * coach scheduled anything: the client granted a scope, and what that grants is the answers,
 * including ones given before this coach arrived. A client who does not want that shares
 * something narrower — which is the whole point of the scopes being separate.
 *
 * Drafts are left out. A check-in with no `submitted_at` is somebody halfway through a sentence
 * about their week, and it syncs so it survives a closed app, not so it can be read over their
 * shoulder.
 */
export async function clientCheckins({ coachId, clientId, limit = 12 }, s = db()) {
  await requireScope(coachId, clientId, 'checkins', s)
  return s`
    select c.*, t.title, t.fields
    from checkins c left join checkin_templates t on t.id = c.template_id
    where c.user_id = ${clientId} and c.deleted_at is null and c.submitted_at is not null
    order by c.on_date desc
    limit ${Math.min(52, Math.max(1, Number(limit) || 12))}`
}

/**
 * When each of these clients last answered, and against which schedule.
 *
 * One query for the whole roster rather than one per client: this feeds the list a coach opens
 * every morning, and a roster of eighty that costs eighty round trips is a screen nobody waits
 * for. Scope is filtered in SQL — a client who has not shared check-ins is absent from the
 * result rather than present with a null, because "no answer yet" and "not shared with you"
 * are different sentences and the roster says the second one.
 */
export async function lastCheckins(coachId, clientIds, s = db()) {
  if (!clientIds?.length) return new Map()
  /* `to_char` rather than the date itself, deliberately. postgres.js turns a `date` into a JS
   * Date at UTC midnight, which is the *previous* calendar day under every local getter west of
   * Greenwich — so a roster built with `getDate()` would tell a coach in Los Angeles their
   * client answered on Friday when they answered on Saturday. A string that is already the
   * calendar day cannot be read wrongly by anybody downstream. */
  const rows = await s`
    select l.client_id,
           sc.weekday,
           (select to_char(max(c.on_date), 'YYYY-MM-DD') from checkins c
             where c.user_id = l.client_id and c.deleted_at is null
               and c.submitted_at is not null) as last_on
    from coaching_links l
    left join checkin_schedules sc on sc.link_id = l.id
    where l.coach_id = ${coachId} and l.client_id in ${s(clientIds)}
      and 'checkins' = any(l.scopes)`
  return new Map(rows.map(r => [r.client_id, { weekday: r.weekday, lastOn: r.last_on }]))
}
