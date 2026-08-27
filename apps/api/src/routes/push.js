/* Web push. Carried over from openGym with the subscription store moved into Postgres.
 *
 * VAPID keys come from the environment rather than being generated on first run. A generated
 * pair that changes when the container is replaced silently breaks every existing subscription,
 * and nobody finds out until their rest timer stops firing.
 */
import webpush from 'web-push'
import { db } from '@gymyar/db'
import { config } from '../config.js'
import { requireUser } from '../session.js'

const configured = !!(config.vapid.publicKey && config.vapid.privateKey)
if (configured) {
  webpush.setVapidDetails(config.vapid.subject, config.vapid.publicKey, config.vapid.privateKey)
}

export async function sendPush(userId, payload) {
  if (!configured) return 0
  const subs = await db()`select * from push_subscriptions where user_id = ${userId}`
  const body = JSON.stringify(payload)
  let sent = 0
  await Promise.all(subs.map(async sub => {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body)
      sent++
    } catch (e) {
      // 404/410 mean the browser threw the subscription away. Keeping it means retrying
      // forever against an endpoint that will never accept again.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await db()`delete from push_subscriptions where id = ${sub.id}`
      }
    }
  }))
  return sent
}

/* Rest timers are scheduled in memory: the longest is a few minutes, and a restart mid-set
 * costing one buzz is a better trade than a table of pending timers to reconcile. */
const timers = new Map()

/**
 * The words a notification shows, taken from the client and falling back to English.
 *
 * A push is the one string this side cannot translate. There is no language on a user or on
 * a subscription, and the locale packs live in the client bundle — so a server that
 * picks the wording sends "Rest over" to someone whose entire app is in Persian. The client
 * knows the language and is awake at the moment it schedules the timer, so it sends the text
 * it wants shown; English stands in when it sends none, which is what an older build and a
 * request that lost the field both look like from here.
 *
 * Coerced and capped because it arrives in a request body — though the only place it can ever
 * be displayed is a device belonging to the person who sent it.
 */
export function notificationText(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text ? text.slice(0, 120) : fallback
}

export default async function pushRoutes(app) {
  app.get('/api/push/public-key', async () => ({ key: config.vapid.publicKey, configured }))

  app.post('/api/push/subscribe', async req => {
    const user = await requireUser(req)
    const sub = req.body?.subscription
    if (!sub?.endpoint || !sub?.keys) throw Object.assign(new Error('subscription required'), { status: 400 })
    await db()`
      insert into push_subscriptions (user_id, endpoint, keys)
      values (${user.id}, ${sub.endpoint}, ${db().json(sub.keys)})
      on conflict (endpoint) do update set user_id = excluded.user_id, keys = excluded.keys`
    return { ok: true }
  })

  app.post('/api/push/unsubscribe', async req => {
    const user = await requireUser(req)
    const endpoint = req.body?.endpoint
    if (endpoint) await db()`delete from push_subscriptions where user_id = ${user.id} and endpoint = ${endpoint}`
    else await db()`delete from push_subscriptions where user_id = ${user.id}`
    return { ok: true }
  })

  app.post('/api/push/rest-timer', async req => {
    const user = await requireUser(req)
    const seconds = Math.min(3600, Math.max(1, Number(req.body?.seconds) || 0))
    // Read now, not when the timer fires: this is the moment the client's language is known.
    const title = notificationText(req.body?.title, 'Rest over')
    const body = notificationText(req.body?.body, 'Next set.')
    clearTimeout(timers.get(user.id))
    timers.set(user.id, setTimeout(() => {
      timers.delete(user.id)
      sendPush(user.id, { title, body, tag: 'rest-timer' })
    }, seconds * 1000).unref?.() ?? timers.get(user.id))
    return { ok: true, seconds }
  })

  app.post('/api/push/rest-timer/cancel', async req => {
    const user = await requireUser(req)
    clearTimeout(timers.get(user.id))
    timers.delete(user.id)
    return { ok: true }
  })

  app.post('/api/push/test', async req => {
    const user = await requireUser(req)
    // The title is the product's name in every language, so only the sentence is translated.
    const body = notificationText(req.body?.body, 'Notifications are working.')
    return { sent: await sendPush(user.id, { title: 'GymYar', body }) }
  })
}
