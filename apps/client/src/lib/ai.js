/* The plan-builder, review and text-log endpoints.
 *
 * Everything here returns something to look at. None of it saves — applying a drafted plan is a
 * separate, explicit act by the person whose plan it is, done through the ordinary store.
 */
import { api } from './api.js'

export const aiStatus = () => api('/api/ai/status')

/* What this instance can do, asked once.
 *
 * A deployment does not grow a vision model while somebody is looking at a workout, so this is
 * a property of the server rather than of a screen — and three screens each asking on mount is
 * three requests for one unchanging answer. The rejection is swallowed into "nothing is
 * configured", which is the same thing a screen does with it and the safe direction to be wrong
 * in: a button that is missing costs a feature, a button that fails costs trust.
 */
let asked = null
export const aiCapabilities = () =>
  (asked ??= aiStatus().catch(() => ({ model: false, vision: false })))

/** For the suite, and for a sign-out that should not carry an answer into the next session. */
export const forgetAiCapabilities = () => { asked = null }

export const draftProgramme = ({ text, brief }) =>
  api('/api/ai/programme', { method: 'POST', body: JSON.stringify({ text, brief }) })

export const reviewMe = (days = 28) => api(`/api/ai/review?days=${days}`)

export const draftClientChange = (clientId, days = 28) =>
  api(`/api/coach/clients/${clientId}/ai-review`, { method: 'POST', body: JSON.stringify({ days }) })

export const parseLogText = text =>
  api('/api/ai/parse-log', { method: 'POST', body: JSON.stringify({ text }) })

/**
 * What a model on the server can see in a form-check photo. Observations, never a change.
 *
 * Only offered when `aiStatus().vision` is true. Unlike everything else here, this one has no
 * template underneath it — an instance with no vision model configured answers 501, and a
 * screen should not have shown the button in the first place.
 */
export const describeFormCheck = (attachmentId, note = null) =>
  api(`/api/ai/form-check/${attachmentId}`, { method: 'POST', body: JSON.stringify({ note }) })

/* The questions the form asks, and the words on them. Kept here so the sheet stays about
 * layout and this stays about vocabulary. */
export const GOAL_OPTIONS = [
  { value: 'strength', label: 'Get stronger', detail: 'Heavier weights, lower reps' },
  { value: 'muscle', label: 'Build muscle', detail: 'Moderate reps, more volume' },
  { value: 'general', label: 'General fitness', detail: 'A bit of everything, nothing extreme' },
  { value: 'endurance', label: 'Build endurance', detail: 'Higher reps, shorter rests' }
]

export const EXPERIENCE_OPTIONS = [
  { value: 'new', label: 'New to this', detail: 'Never trained, or only a few weeks' },
  { value: 'returning', label: 'Coming back', detail: 'Trained before, been away' },
  { value: 'experienced', label: 'Experienced', detail: 'Train regularly and know the lifts' }
]

export const EQUIPMENT_OPTIONS = [
  { value: 'body weight', label: 'Just my body' },
  { value: 'dumbbell', label: 'Dumbbells' },
  { value: 'barbell', label: 'Barbell and plates' },
  { value: 'cable', label: 'Cable machine' },
  { value: 'leverage machine', label: 'Gym machines' },
  { value: 'band', label: 'Resistance bands' },
  { value: 'kettlebell', label: 'Kettlebells' },
  { value: 'smith machine', label: 'Smith machine' }
]
