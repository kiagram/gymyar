// Web Push subscribe/unsubscribe — requires a signed-in profile (subscriptions are stored
// server-side per user, same as everything else under /api).
import { api } from './api.js'
import { t } from './i18n.js'

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
export const pushPermission = () => (pushSupported() ? Notification.permission : 'unsupported')

const urlBase64ToUint8Array = b64 => {
  const padded = (b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

export async function enablePush() {
  if (!pushSupported()) throw new Error('Push notifications are not supported in this browser')
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('Notifications permission was not granted')
  const reg = await navigator.serviceWorker.ready
  const { key } = await api('/api/push/public-key')
  const subscription = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) })
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: subscription.toJSON() }) })
}

export async function disablePush() {
  if (!pushSupported()) return
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (!sub) return
  await sub.unsubscribe()
  await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {})
}

// The sentence travels with the request — see the note on the rest timer in store/useUI.js.
export const sendTestPush = () =>
  api('/api/push/test', { method: 'POST', body: JSON.stringify({ body: t('Notifications are working.') }) })

/* Which server-sent notifications this person wants, as one switch per thing that happens.
 *
 * The stored shape is deliberately loose and is read by the API as well as by this screen:
 * absent or `true` means everything, `false` means nothing, and an object switches kinds off
 * one at a time. Absent is the common case and has to mean yes — somebody who has never opened
 * this screen has not opted out of anything.
 *
 * Accepting and declining are one switch here and two kinds underneath, because to the coach
 * waiting on an answer they are the same event with two outcomes. A person who wants to hear
 * "they took it" and not "they did not" is not a person this setting needs to serve.
 */
const GROUPS = {
  message: ['message'],
  proposal: ['proposal'],
  accepted: ['accepted', 'declined'],
  checkin_due: ['checkin_due'],
  coach_digest: ['coach_digest']
}

export const wantsPush = (S, group) => {
  const push = S?.push
  if (push == null || push === true) return true
  if (push === false) return false
  return (GROUPS[group] || [group]).every(k => push[k] !== false)
}

/**
 * The stored preference with one group switched.
 *
 * Returns null when everything is on again, so a person who toggles something off and back on
 * ends up with the state they started in rather than an object of `true`s that would go stale
 * the day a fifth kind is added.
 */
export function withPush(current, group, on) {
  const next = current && typeof current === 'object' ? { ...current } : {}
  if (current === false) for (const g of Object.values(GROUPS)) for (const k of g) next[k] = false
  for (const k of GROUPS[group] || [group]) {
    if (on) delete next[k]
    else next[k] = false
  }
  return Object.keys(next).length ? next : null
}
