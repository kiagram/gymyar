/* Web push. Carried over from openGym with the subscription store moved into Postgres.
 *
 * VAPID keys come from the environment rather than being generated on first run. A generated
 * pair that changes when the container is replaced silently breaks every existing subscription,
 * and nobody finds out until their rest timer stops firing.
 */
import webpush from 'web-push'
import { db } from '@gymbuddy/db'
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
    clearTimeout(timers.get(user.id))
    timers.set(user.id, setTimeout(() => {
      timers.delete(user.id)
      sendPush(user.id, { title: 'Rest over', body: 'Next set.', tag: 'rest-timer' })
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
    return { sent: await sendPush(user.id, { title: 'GymBuddy', body: 'Notifications are working.' }) }
  })
}
