/* The check-in a person is filling in right now.
 *
 * The questions come from the server — a coach's template lives there, and it is the one part
 * of this that cannot be known offline. Everything after that is local: the answers are the
 * client's own rows, saved into state and pushed with everything else.
 *
 * The date arithmetic is the part worth reading. A check-in is filed under the day it is
 * *about*, not the day it was typed, so somebody answering Sunday evening for a Saturday due
 * date edits the same row they would have written on Saturday. Getting that wrong puts two
 * check-ins in one week and none in the next, and the symptom is a coach's list with a gap in it.
 */
import { api } from './api.js'
import {
  todayISO, isoOf, startOfWeek, checkinDateFor, normaliseAnswers, missingFrom, BUILT_IN_FIELDS
} from '@gymyar/domain'

/** Which questions this person is being asked, and by whom. */
export const fetchCheckinForm = () => api('/api/checkin')

/**
 * What somebody with no answer from the server fills in.
 *
 * Not an error state. A client with no coach is answering the built-in set, and so is anybody
 * whose app could not reach the server just now — the questions are the same ones, and refusing
 * to show a form because a fetch failed would make a feature that works offline look like one
 * that does not.
 *
 * No title. A coach's template has one and it is *their words*, so it is rendered as written and
 * never translated; this one is a label the app is naming, so the screen calls it `t('Check-in')`
 * and it comes out in the reader's language. A literal here would have put one English heading
 * on an otherwise Persian form — which is exactly what it did until somebody looked.
 */
export const BUILT_IN = { templateId: null, title: null, fields: BUILT_IN_FIELDS, weekday: null }

/**
 * The check-in for the week containing `on`, as the form needs it.
 *
 * `weekday` is the day the coach asked for; without one — the built-in check-in, which nobody
 * scheduled — the week's own first day is used, so the row is still stable for the whole week
 * rather than moving every time somebody opens the form.
 */
export function currentCheckin(S, form, on = todayISO()) {
  const weekStart = startOfWeek(on)
  const weekday = form?.weekday == null ? weekStart.getDay() : form.weekday
  const date = isoOf(checkinDateFor(weekStart, weekday))
  const existing = (S.checkins || []).find(c => c.d === date)

  return {
    date,
    answers: existing?.a ?? {},
    submittedAt: existing?.at ?? null,
    submitted: !!existing?.at
  }
}

/**
 * Write a check-in into state, in place — the shape `update()` hands its callback.
 *
 * Answers go through the domain here as well as on the server. Not belt and braces: this is the
 * copy the app itself reads back for its own charts, so an unclamped value typed offline would
 * be wrong on this screen for as long as the phone stayed offline, whatever the server later
 * decided about it.
 *
 * `submit` false keeps it a draft. A draft still syncs — it survives a closed tab — and a coach
 * never sees one.
 */
export function saveCheckin(S, { date, templateId = null, fields, answers, submit = true }) {
  const clean = normaliseAnswers(fields, answers)
  const list = S.checkins || []
  const existing = list.find(c => c.d === date)
  const at = submit ? new Date().toISOString() : null

  if (existing) {
    existing.a = clean
    existing.tpl = templateId
    // A draft saved over a submitted answer does not un-submit it. Somebody reopening last
    // Saturday to add a sentence has not withdrawn what they already said.
    if (at || !existing.at) existing.at = at ?? existing.at
  } else {
    S.checkins = [...list, { d: date, tpl: templateId, a: clean, at }]
      .sort((a, b) => (a.d < b.d ? -1 : 1))
  }
  return clean
}

/** Required questions with no answer yet. Empty means it can be sent. */
export const stillMissing = (fields, answers) => missingFrom(fields, answers)
