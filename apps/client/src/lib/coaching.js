/* Coaching endpoints, client side.
 *
 * None of this touches the sync engine. Coaching data is read fresh when a screen opens rather
 * than merged into local state: a coach reading someone else's training must never end up with
 * it in their own state object, and "the roster is a few seconds stale" is not a problem worth
 * a second sync protocol.
 */
import { api } from './api.js'

/* ------------------------------------------------------------- as coach ---- */

export const fetchRoster = (days = 28) => api(`/api/coach/clients?days=${days}`)
export const fetchClient = id => api(`/api/coach/clients/${id}`)

export const createInvite = ({ email, scopes }) =>
  api('/api/coach/invites', { method: 'POST', body: JSON.stringify({ email, scopes }) })

export const proposeRoutine = (clientId, { routineId, payload, note }) =>
  api(`/api/coach/clients/${clientId}/propose`, {
    method: 'POST', body: JSON.stringify({ routineId, payload, note })
  })

/** A habit, through the same endpoint and the same accept-or-decline as a programme. */
export const proposeHabit = (clientId, { habitId, title, target, note }) =>
  api(`/api/coach/clients/${clientId}/propose`, {
    method: 'POST',
    body: JSON.stringify({ kind: 'habit', subjectId: habitId, payload: { title, target }, note })
  })

/* ------------------------------------------------------------ check-ins ---- */

export const fetchTemplates = () => api('/api/coach/checkin-templates')

export const saveTemplate = ({ id, title, fields }) =>
  api('/api/coach/checkin-templates', {
    method: 'POST', body: JSON.stringify({ id, title, fields })
  })

export const archiveTemplate = id =>
  api(`/api/coach/checkin-templates/${id}`, { method: 'DELETE' })

export const fetchSchedule = clientId =>
  api(`/api/coach/clients/${clientId}/checkin-schedule`)

export const setSchedule = (clientId, { templateId, weekday }) =>
  api(`/api/coach/clients/${clientId}/checkin-schedule`, {
    method: 'POST', body: JSON.stringify({ templateId, weekday })
  })

export const clearSchedule = clientId =>
  api(`/api/coach/clients/${clientId}/checkin-schedule`, { method: 'DELETE' })

export const clientCheckins = clientId =>
  api(`/api/coach/clients/${clientId}/checkins`)

export const clientHabits = clientId =>
  api(`/api/coach/clients/${clientId}/habits`)

/* ------------------------------------------------------------ as client ---- */

export const fetchCoaches = () => api('/api/coaches')
export const previewInvite = code => api(`/api/invites/${encodeURIComponent(code)}`)

export const acceptInvite = (code, scopes) =>
  api(`/api/invites/${encodeURIComponent(code)}/accept`, {
    method: 'POST', body: JSON.stringify({ scopes })
  })

export const declineInvite = code =>
  api(`/api/invites/${encodeURIComponent(code)}/decline`, { method: 'POST', body: '{}' })

export const updateScopes = (linkId, scopes) =>
  api(`/api/coaches/${linkId}/scopes`, { method: 'POST', body: JSON.stringify({ scopes }) })

export const endCoaching = linkId =>
  api(`/api/coaches/${linkId}/end`, { method: 'POST', body: '{}' })

/* ----------------------------------------------------------- proposals ---- */

export const fetchProposals = () => api('/api/proposals')
export const acceptProposal = id => api(`/api/proposals/${id}/accept`, { method: 'POST', body: '{}' })
export const declineProposal = id => api(`/api/proposals/${id}/decline`, { method: 'POST', body: '{}' })

/* ------------------------------------------------------------ messages ---- */

export const fetchThread = linkId => api(`/api/threads/${linkId}`)
export const sendMessage = (linkId, body, context = {}) =>
  api(`/api/threads/${linkId}`, { method: 'POST', body: JSON.stringify({ body, ...context }) })

/* --------------------------------------------------------------- shape ---- */

/** Human label for a scope, and what granting it actually exposes. */
export const SCOPE_INFO = {
  programmes: { label: 'Programmes', detail: 'Your routines and weekly schedule' },
  workouts:   { label: 'Workouts',   detail: 'Every session you log, set by set' },
  bodyweight: { label: 'Body weight', detail: 'Your weigh-ins and goal' },
  /* The wording says "sent", because that is what happens: a check-in is answered and shared in
   * one act, and nothing here is read off a device without being written first. */
  checkins: { label: 'Check-ins', detail: 'The weekly answers you send' },
  /* Separate from check-ins on the screen as well as in the schema, because they are two
   * different pictures: a summary you wrote, and a day-by-day record of what you did. */
  habits: { label: 'Habits', detail: 'The daily habits you agree on, and whether you tick them' },
  /* Its own line, and worded so that what is being agreed to is unmistakable. Sharing a number
   * about a body and sharing a picture of one are not the same decision, and a consent screen
   * that treats them as one has not obtained consent for the second. */
  photos: { label: 'Progress photos', detail: 'Photographs you take of yourself' }
}

/** Days since a date, or null. Used for "last trained" without pulling in a date library. */
export const daysSince = at => {
  if (!at) return null
  return Math.floor((Date.now() - new Date(at).getTime()) / 86400000)
}
