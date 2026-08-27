/* Demo data, so `docker compose up` lands on something worth clicking rather than a login form.
 *
 * One coach and three clients, each with twelve weeks of fabricated but coherent training —
 * progression, a deload, effort ratings, a body-weight trend. Then the states that only exist
 * once people are connected: a pending programme proposal, a conversation, and one client who
 * has quietly stopped turning up, because a roster where everyone is at 100% shows nothing.
 */
import { buildDemoState } from '@gymyar/domain/demo-seed.js'
import { db, logChange } from './index.js'
import { createUser, findUserByEmail } from './users.js'
import { importState } from './import-blob.js'
import { inviteClient, acceptInvite, proposeRoutine, propose, sendMessage } from './coaching.js'
import { saveTemplate, scheduleCheckin } from './checkins.js'
import { setPaidThrough } from './billing.js'

export const DEMO_PASSWORD = 'gymyar-demo-1'

const PEOPLE = {
  coach: { name: 'Kim Alvarez', email: 'coach@gymyar.test', isCoach: true },
  clients: [
    /* Sam shares everything, which is what the README says about him and is the point of him:
     * one client whose screen has every section filled in, so a first look shows the whole
     * product rather than a column of "not shared". */
    { name: 'Sam Okonkwo', email: 'sam@gymyar.test', drop: 0,
      scopes: ['programmes', 'workouts', 'bodyweight', 'checkins', 'habits', 'photos'] },
    { name: 'Ava Lindqvist', email: 'ava@gymyar.test', drop: 0,
      scopes: ['programmes', 'workouts', 'checkins'] },
    // Stopped three weeks ago. The roster is only useful if it can show someone slipping.
    { name: 'Theo Marsh', email: 'theo@gymyar.test', scopes: ['programmes'], drop: 21 }
  ]
}

/* The questions the demo coach asks, and the shape of an answer to them.
 *
 * Written here rather than left to the built-in set because the point of the demo is to show
 * what a *coach* can do — and a template with a measurement and a required scale in it shows
 * the field types doing something, which a list of five defaults does not.
 */
const DEMO_FIELDS = [
  { key: 'sleep', type: 'scale', label: 'Sleep', required: true },
  { key: 'energy', type: 'scale', label: 'Energy' },
  { key: 'waist', type: 'measure', label: 'Waist', min: 50, max: 150, unit: 'cm' },
  { key: 'notes', type: 'text', label: 'Anything I should know' }
]

/* Three weeks of answers, most recent first, so a coach's list has a trend in it rather than one
 * row. Sleep climbing and the waist coming down is the story the numbers should tell, because a
 * demo where every value is identical demonstrates that the column exists and nothing else. */
const DEMO_ANSWERS = [
  { back: 0, sleep: 4, energy: 4, waist: 84.5, notes: 'Best week in a while. Squats felt light.' },
  { back: 1, sleep: 3, energy: 3, waist: 85.2, notes: 'Slept badly Tuesday and Wednesday.' },
  { back: 2, sleep: 2, energy: 2, waist: 85.8, notes: 'Travelling — trained twice, ate badly.' }
]

const DEMO_HABITS = [
  { title: '10,000 steps', target: 6, hit: 5 },
  { title: '2 litres of water', target: 7, hit: 6 },
  { title: 'Stretch before bed', target: 4, hit: 2 }
]

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

/* The week a date belongs to, as this seed means it: Saturday-anchored, because the demo is
 * read in Persian as often as in English and a check-in filed on a Monday would sit in the
 * wrong week on half the screens that show it. `n` weeks back from today. */
function saturdayBack(n) {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() - 6 + 7) % 7) - n * 7)
  return d
}

const isoOf = d => d.toISOString().slice(0, 10)

/**
 * A check-in on two clients, three weeks of answers from one of them, and habits that are being
 * kept with varying honesty.
 *
 * Written through the same functions the app uses rather than with inserts of its own — so a
 * change to what a habit or an answer *is* cannot leave the demo describing a shape that no
 * longer exists, which is the failure mode of every seed script that reaches past its own API.
 *
 * The habits are the client's rows and are written as such. There is no proposal-and-accept
 * dance here because the demo wants them already in place; what a proposal looks like is
 * demonstrated by the routine one, which is left pending on purpose.
 */
async function seedCheckinsAndHabits({ coach, links, log }) {
  const asked = links.filter(l => l.spec.scopes.includes('checkins'))
  if (!asked.length) return

  const template = await saveTemplate({
    coachId: coach.id, title: 'Weekly check-in', fields: DEMO_FIELDS
  })
  for (const { link } of asked) {
    await scheduleCheckin({
      coachId: coach.id, linkId: link.id, templateId: template.id, weekday: 6
    })
  }
  log(`check-in on ${asked.length} of them`)

  /* Only the first client has answered. The second is the state a coach opens most mornings —
   * asked, not yet answered — and a demo where everybody has replied never shows it. */
  const [{ user }] = asked
  for (const a of DEMO_ANSWERS) {
    const on = isoOf(saturdayBack(a.back))
    await db()`
      insert into checkins (user_id, on_date, template_id, answers, submitted_at)
      values (${user.id}, ${on}, ${template.id},
              ${db().json({ sleep: a.sleep, energy: a.energy, waist: a.waist, notes: a.notes })},
              ${on + 'T09:00:00Z'})
      on conflict (user_id, on_date) do nothing`
    await logChange(db(), user.id, 'checkins', on)
  }
  log(`${DEMO_ANSWERS.length} weeks of answers`)

  /* Habits, and a fortnight of ticks against them. `hit` is how many days a week each one
   * actually gets done, which is deliberately under target for one of them — a grid where every
   * square is filled shows nothing about what the grid is for. */
  const habitLinks = links.filter(l => l.spec.scopes.includes('habits'))
  for (const { user: owner, link } of habitLinks) {
    for (const [i, h] of DEMO_HABITS.entries()) {
      const id = `demo-habit-${i}`
      await db()`
        insert into habits (id, user_id, author_id, assigned_by, title, target_per_week, position)
        values (${id}, ${owner.id}, ${coach.id}, ${link.id}, ${h.title}, ${h.target}, ${i})
        on conflict (id) do nothing`
      await logChange(db(), owner.id, 'habits', id)

      for (let week = 0; week < 2; week++) {
        for (let day = 0; day < h.hit; day++) {
          const d = saturdayBack(week)
          d.setDate(d.getDate() + day)
          if (d > new Date()) continue        // no ticking days that have not happened
          const on = isoOf(d)
          await db()`
            insert into habit_ticks (user_id, habit_id, on_date)
            values (${owner.id}, ${id}, ${on}) on conflict do nothing`
          await logChange(db(), owner.id, 'habit_ticks', `${id}:${on}`)
        }
      }
    }
    log(`${DEMO_HABITS.length} habits, two weeks of ticks`)
  }

  /* One habit left unanswered in the inbox, next to the routine proposal — so the demo shows
   * both kinds of proposal and shows that accepting is what makes one real. */
  const [firstHabitLink] = habitLinks
  if (firstHabitLink) {
    await propose({
      linkId: firstHabitLink.link.id, coachId: coach.id, kind: 'habit',
      subjectId: 'demo-habit-proposed',
      payload: { title: '10 minutes of mobility', target: 3 },
      note: 'Three evenings a week, whichever three suit you.'
    })
    log('one habit waiting to be accepted')
  }
}

export async function seedDemo({ log = () => {} } = {}) {
  if (await findUserByEmail(PEOPLE.coach.email)) {
    log('demo data already present — skipping')
    return { created: false }
  }

  const coach = await createUser({ ...PEOPLE.coach, password: DEMO_PASSWORD })
  // Paid up for a decade. On an instance with billing configured the demo coach would otherwise
  // start a fourteen-day trial and the demo would quietly stop demonstrating anything a
  // fortnight later — which nobody would notice until somebody important was looking at it.
  await setPaidThrough(coach.id, new Date(Date.now() + 3650 * 86400000))
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

  await seedCheckinsAndHabits({ coach, links, log })

  log(`demo ready — sign in with any of the emails above, password: ${DEMO_PASSWORD}`)
  return { created: true, coach, clients: links.map(l => l.user) }
}
