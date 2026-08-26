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
