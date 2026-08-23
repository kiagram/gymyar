/* The exercise library, served rather than bundled.
 *
 * The client still ships the catalogue for offline use, but the server needs to answer for it
 * too — the coach picking movements for someone else's programme is not that client, and the
 * AI worker has no bundle at all.
 */
import { db } from '@gymbuddy/db'
import { requireUser } from '../session.js'

export default async function exerciseRoutes(app) {
  app.get('/api/exercises', async req => {
    const user = await requireUser(req)
    const q = String(req.query?.q || '').trim()
    const bodyPart = req.query?.bodyPart ? String(req.query.bodyPart) : null
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 50))
    const s = db()
    // Own exercises first: someone searching "sled" means the one they created, not a
    // library match that happens to share a word.
    const rows = await s`
      select id, name, body_part, target, equipment, is_cardio, is_bodyweight, per_side,
             image_url, animation_url, attribution, owner_id is not null as custom
      from exercises
      where deleted_at is null
        and (owner_id is null or owner_id = ${user.id})
        ${q ? s`and name ilike ${'%' + q + '%'}` : s``}
        ${bodyPart ? s`and body_part = ${bodyPart}` : s``}
      order by (owner_id is not null) desc, name
      limit ${limit}`
    return { exercises: rows }
  })

  app.get('/api/exercises/body-parts', async req => {
    await requireUser(req)
    const rows = await db()`
      select body_part, count(*)::int as n from exercises
      where deleted_at is null and owner_id is null group by body_part order by body_part`
    return { bodyParts: rows }
  })
}
