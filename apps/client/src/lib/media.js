/* Attachments, client side.
 *
 * Like `coaching.js`, none of this touches the sync engine. An attachment is not part of the
 * offline state and could not honestly be: the bytes live on a server, so a row in the local
 * blob would promise a video that cannot play with no signal. Screens fetch what they need
 * when they open, and a session with no connection shows the training it always did with no
 * attachments beside it — which is the truth.
 *
 * The URLs that come back are signed and expire in minutes. That is deliberate and it has one
 * consequence worth knowing about up here: **do not keep them.** Putting one in local state,
 * in a cache or in a component that outlives the screen produces a link that works while you
 * are testing and is dead by the time somebody scrolls back to it. Re-fetch instead; it is one
 * request and it re-checks the permission, which is the other half of why they expire.
 */
import { api, upload } from './api.js'

/* -------------------------------------------------------------- limits ---- */

/* What the server will accept, filled in from `/api/config` at boot. The defaults match
 * `packages/storage/src/index.js`, and they are only ever the answer before the app has asked
 * — a deployment that raised its video limit says so and this follows. */
let limits = { photo: 8 * 1024 * 1024, video: 60 * 1024 * 1024, audio: 8 * 1024 * 1024 }
let maxVideoSeconds = 60

export function setMediaLimits(cfg) {
  if (cfg?.limits) limits = { ...limits, ...cfg.limits }
  if (cfg?.maxVideoSeconds) maxVideoSeconds = cfg.maxVideoSeconds
}
export const mediaLimits = () => ({ ...limits })
export const videoSecondsLimit = () => maxVideoSeconds

/** Which kind a picked file is, by the same taxonomy the server uses. Null = not accepted. */
export const kindOf = file => {
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('image/')) return 'photo'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return null
}

/**
 * Is this file small enough to bother sending?
 *
 * A courtesy check, not the check — the server enforces the same ceiling and does not trust
 * this one. It exists because the alternative is spending a minute of somebody's mobile data
 * to arrive at a rejection, and a browser reports a file's size for free before any of it
 * moves.
 */
export const tooBig = file => {
  const kind = kindOf(file)
  return !!kind && file.size > (limits[kind] ?? 0)
}

/* -------------------------------------------------------------- upload ---- */

const q = params => new URLSearchParams(params).toString()

export const uploadFormCheck = ({ workoutId, exerciseId, file, onProgress, signal }) =>
  upload(`/api/attachments?${q({ subject: 'form_check', workout: workoutId, exercise: exerciseId })}`,
    file, { onProgress, signal }).then(r => r.attachment)

export const uploadProgressPhoto = ({ date, file, onProgress, signal }) =>
  upload(`/api/attachments?${q({ subject: 'progress', date })}`, file, { onProgress, signal })
    .then(r => r.attachment)

/**
 * Attach something to a message that already exists.
 *
 * The message first, then the file — a row cannot point at a message that has not been sent.
 * The composer sends the text, gets an id back and uploads against it, so a failed upload
 * leaves a message that was said rather than a message that was lost.
 */
export const uploadToMessage = ({ messageId, file, onProgress, signal }) =>
  upload(`/api/attachments?${q({ subject: 'message', message: messageId })}`, file,
    { onProgress, signal }).then(r => r.attachment)

/* ------------------------------------------------------------- reading ---- */

export const formChecksFor = workoutId =>
  api(`/api/attachments?${q({ workout: workoutId })}`).then(r => r.attachments)

export const progressPhotos = (limit = 60) =>
  api(`/api/attachments/progress?${q({ limit })}`).then(r => r.attachments)

export const mediaUsage = () => api('/api/attachments/usage')

export const setCaption = (id, caption) =>
  api(`/api/attachments/${id}`, { method: 'PATCH', body: JSON.stringify({ caption }) })
    .then(r => r.attachment)

export const deleteAttachment = id => api(`/api/attachments/${id}`, { method: 'DELETE' })

/* --------------------------------------------------------- as a coach ---- */

export const clientFormChecks = (clientId, workoutId) =>
  api(`/api/coach/clients/${clientId}/attachments?${q({ workout: workoutId })}`)
    .then(r => r.attachments)

export const clientProgress = (clientId, limit = 60) =>
  api(`/api/coach/clients/${clientId}/progress?${q({ limit })}`).then(r => r.attachments)

/* --------------------------------------------------------------- shape ---- */

/** Human size, for a screen that has to say how much of a quota is gone. */
export const fmtBytes = (n, digits = 1) => {
  const units = ['B', 'KB', 'MB', 'GB']
  let v = Number(n) || 0
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${i === 0 ? v : v.toFixed(digits)} ${units[i]}`
}
