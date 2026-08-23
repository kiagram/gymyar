/* Demo data, so `docker compose up` lands on something worth clicking rather than a login form.
 *
 * One coach and three clients, each with twelve weeks of fabricated but coherent training —
 * progression, a deload, effort ratings, a body-weight trend. Then the states that only exist
 * once people are connected: a pending programme proposal, a conversation, and one client who
 * has quietly stopped turning up, because a roster where everyone is at 100% shows nothing.
 */
import { buildDemoState } from '@gymbuddy/domain/demo-seed.js'
import { db } from './index.js'
import { createUser, findUserByEmail } from './users.js'
import { importState } from './import-blob.js'
import { inviteClient, acceptInvite, proposeRoutine, sendMessage } from './coaching.js'

export const DEMO_PASSWORD = 'gymbuddy-demo-1'

const PEOPLE = {
  coach: { name: 'Kim Alvarez', email: 'coach@gymbuddy.test', isCoach: true },
  clients: [
    { name: 'Sam Okonkwo', email: 'sam@gymbuddy.test', scopes: ['programmes', 'workouts', 'bodyweight'], drop: 0 },
    { name: 'Ava Lindqvist', email: 'ava@gymbuddy.test', scopes: ['programmes', 'workouts'], drop: 0 },
    // Stopped three weeks ago. The roster is only useful if it can show someone slipping.
    { name: 'Theo Marsh', email: 'theo@gymbuddy.test', scopes: ['programmes'], drop: 21 }
  ]
}

/** Cut the last `days` of training so a client reads as having drifted off. */
function trimRecent(S, days) {
  if (!days) return S
  const cutoff = Date.now() - days * 86400000
  return {
    ...S,
    workouts: (S.workouts || []).filter(w => (w.start || 0) < cutoff),
    bodyweight: (S.bodyweight || []).filter(b => Date.parse(b.d) < cutoff)
  }
}

export async function seedDemo({ log = () => {} } = {}) {
  if (await findUserByEmail(PEOPLE.coach.email)) {
    log('demo data already present — skipping')
    return { created: false }
  }

  const coach = await createUser({ ...PEOPLE.coach, password: DEMO_PASSWORD })
  log(`coach ${coach.email}`)

  const links = []
  for (const spec of PEOPLE.clients) {
    const user = await createUser({ name: spec.name, email: spec.email, password: DEMO_PASSWORD })
    await importState(user.id, trimRecent(buildDemoState(), spec.drop))

    const invite = await inviteClient({ coachId: coach.id, email: spec.email, scopes: spec.scopes })
    const link = await acceptInvite({ inviteCode: invite.invite_code, clientId: user.id })
    links.push({ user, link, spec })
    log(`client ${user.email} (${spec.scopes.join(', ')})`)
  }

  // A proposal waiting on the first client, so the inbox is not empty on first look.
  const [first] = links
  const [routine] = await db()`
    select * from routines where user_id = ${first.user.id} and deleted_at is null
    order by position limit 1`
  if (routine) {
    const heavier = (routine.exercises || []).map((e, i) =>
      (i === 0 ? { ...e, sets: (e.sets || 3) + 1, reps: Math.max(3, (e.reps || 5) - 1) } : e))
    await proposeRoutine({
      linkId: first.link.id, coachId: coach.id, routineId: routine.id,
      payload: { ...routine, exercises: heavier },
      note: 'Your top set has been moving well — let us add a set and drop a rep for four weeks.'
    })
    log('one proposal waiting')
  }

  await sendMessage({
    linkId: first.link.id, senderId: coach.id,
    body: 'Nice work on the squats last week. How did the last set feel?'
  })
  await sendMessage({
    linkId: first.link.id, senderId: first.user.id,
    body: 'Heavy but clean. Could probably have done one more.'
  })

  log(`demo ready — sign in with any of the emails above, password: ${DEMO_PASSWORD}`)
  return { created: true, coach, clients: links.map(l => l.user) }
}
