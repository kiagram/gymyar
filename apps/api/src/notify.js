/* Notifications the server writes, in the language of the person who will read them.
 *
 * ## Why the wording is here and not in the locale packs
 *
 * Everything the app says is translated on the client, from packs it lazy-loads. A push cannot
 * be: it is composed on the server, at the moment somebody else did something, for a device that
 * is not running the app. There is nobody to ask.
 *
 * The rest timer's push dodges this by having the client send the text it wants shown — it is
 * scheduling a reminder for itself, so it is awake and knows its own language (see
 * `notificationText` in routes/push.js). Nothing here can do that. A coach sending a message at
 * midnight is not a moment their client's phone participates in.
 *
 * So this is a small server-side pack, the same shape and for the same reason as the planner's
 * rationale strings in `packages/ai/src/planner-strings.js`. English and Persian, because those
 * are the two languages this product writes prose in; anything else falls back to the English
 * source string per key, which is a readable notification rather than a missing one.
 *
 * ## Language is a parameter, never module state
 *
 * The domain's `t` is a registered global, set once by whoever booted. That is right for a
 * client running one language and wrong here: this process serves a Persian lifter and an
 * English one in the same second, and a global would hand one of them the other's language.
 * Every function here takes the locale it is rendering for.
 *
 * ## A push is an accelerator, never the record
 *
 * Every notification below describes something that is *already a row* — a message, a proposal.
 * The app shows all of it without any of this working, which is what makes it safe to have push
 * fail silently, and what makes it survivable that web push may not reach a device in Iran at
 * all. Nothing is ever only a notification.
 */
import { db } from '@gymyar/db'
import { sendPush } from './routes/push.js'

/* The wording, keyed by the English source string like every other pack in this repo. */
const FA = {
  'New message': 'پیام تازه',
  '{0} sent you a message': '{0} برایت پیام فرستاد',
  'A change to your programme': 'تغییری در برنامه‌ات',
  '{0} proposed a change to {1}': '{0} تغییری برای {1} پیشنهاد داد',
  'A habit to try': 'یک عادت برای امتحان',
  '{0} suggested: {1}': '{0} پیشنهاد داد: {1}',
  'Proposal accepted': 'پیشنهاد پذیرفته شد',
  '{0} accepted {1}': '{0} {1} را پذیرفت',
  'Proposal declined': 'پیشنهاد رد شد',
  '{0} declined {1}': '{0} {1} را رد کرد',
  'your programme': 'برنامه‌ات',
  'a habit': 'یک عادت',
  'Your check-in is due': 'وقت گزارش هفتگی‌ات است',
  'Tell your coach how the week went': 'به مربی‌ات بگو هفته چطور گذشت',
  'Your clients today': 'شاگردهایت امروز',
  '{0} answered their check-in': '{0} نفر گزارششان را دادند',
  '{0} have not trained in a fortnight': '{0} نفر دو هفته است تمرین نکرده‌اند'
}

const PACKS = { fa: FA }

/* Which numbering system a language writes. Persian digits, so a push saying "۳" sits beside an
 * app that has been writing ۳ all along rather than looking like a different product. */
const NUMBER_LOCALE = { fa: 'fa-IR' }

/**
 * A `t`-shaped translator for one language, with numeric arguments localised.
 *
 * The digit handling matches the client's `t` exactly — numbers are formatted, strings are
 * passed through untouched, because a string argument is somebody's name or their routine's
 * title and formatting it would be an edit.
 */
export function translatorFor(locale) {
  const lang = String(locale || '').split('-')[0]
  const pack = PACKS[lang]
  const numbers = NUMBER_LOCALE[lang]
  return (s, ...args) => {
    let v = (pack && pack[s]) || s
    for (let i = 0; i < args.length; i++) {
      const a = args[i]
      const shown = typeof a === 'number' && Number.isFinite(a) && numbers
        ? a.toLocaleString(numbers, { useGrouping: false })
        : a
      v = v.replaceAll('{' + i + '}', shown)
    }
    return v
  }
}

/**
 * What each kind of notification says, given a translator and the facts.
 *
 * `url` is where tapping it should land. It is a hash route because that is what this app's
 * router uses, and because a path would 404 on a static host serving one index.html.
 */
const KINDS = {
  message: (t, { from }) => ({
    title: t('New message'),
    body: t('{0} sent you a message', from),
    url: '#/coaching'
  }),
  proposal: (t, { from, kind, subject }) => (kind === 'habit'
    ? { title: t('A habit to try'), body: t('{0} suggested: {1}', from, subject), url: '#/coaching' }
    : { title: t('A change to your programme'), body: t('{0} proposed a change to {1}', from, subject), url: '#/coaching' }),
  /* `kind` is the proposal's kind, not a rendered noun. Handing a translator an English phrase
   * to substitute would put "your programme" inside an otherwise Persian sentence — the argument
   * has to be translated, and only the builder knows to translate this one and not the name. */
  accepted: (t, { from, kind }) => ({
    title: t('Proposal accepted'),
    body: t('{0} accepted {1}', from, t(kind === 'habit' ? 'a habit' : 'your programme')),
    url: '#/coach'
  }),
  declined: (t, { from, kind }) => ({
    title: t('Proposal declined'),
    body: t('{0} declined {1}', from, t(kind === 'habit' ? 'a habit' : 'your programme')),
    url: '#/coach'
  }),

  /* The two nobody caused — see reminders.js. Both land on the screen that answers them, because
   * a notification whose only action is "open the app and go looking" is a notification that
   * gets dismissed. */
  checkin_due: t => ({
    title: t('Your check-in is due'),
    body: t('Tell your coach how the week went'),
    url: '#/home'
  }),

  /* Assembled from two counts rather than a sentence per case, so a digest with only one thing
   * in it says only that thing. Zero of both never reaches here — a push that reads "0 and 0"
   * is why people turn digests off. */
  coach_digest: (t, { answered = 0, quiet = 0 }) => ({
    title: t('Your clients today'),
    body: [
      answered ? t('{0} answered their check-in', answered) : null,
      quiet ? t('{0} have not trained in a fortnight', quiet) : null
    ].filter(Boolean).join(' · '),
    url: '#/coach'
  })
}

/**
 * Whether this person wants this kind of push.
 *
 * Preferences live in `user_settings`, which is the client's own synced blob — so the switch a
 * person flips in Settings is the same row this reads, with no second store to keep in step.
 * Absent means yes: somebody who has never opened the setting has not opted out of anything,
 * and a feature that stays silent until it is discovered is a feature nobody discovers.
 */
export async function wants(userId, kind, s = db()) {
  const [row] = await s`select settings from user_settings where user_id = ${userId}`
  const push = row?.settings?.push
  if (push == null) return true
  if (push === false) return false                 // the whole switch, off
  return push[kind] !== false                      // or one kind of it
}

/**
 * Send a notification, and never let it break what it is announcing.
 *
 * Every caller has just written a row. If push is misconfigured, the subscription is stale, the
 * recipient has opted out, or FCM is unreachable from wherever this is deployed — none of that
 * should turn a sent message into a failed request. So this swallows everything and returns how
 * many devices it reached, which is zero far more often than a product would like.
 */
export async function notify(userId, kind, args = {}, s = db()) {
  try {
    const build = KINDS[kind]
    if (!build) return 0
    if (!(await wants(userId, kind, s))) return 0

    const [user] = await s`select locale from users where id = ${userId}`
    const payload = build(translatorFor(user?.locale), args)
    return await sendPush(userId, { ...payload, kind })
  } catch {
    return 0
  }
}

/**
 * The other person in a coaching relationship.
 *
 * Extracted so the one property that matters here is testable without a push subscription, a
 * VAPID key or a network: a message notifies the person who did *not* send it. Inline in the
 * route this was a ternary nobody could get at, and getting it backwards would have pushed
 * every coach their own messages — annoying, and the kind of thing that is noticed by users
 * rather than by tests.
 *
 * Null when the link is missing or the sender is in neither seat, which is not a case any route
 * reaches — `sendMessage` has already refused a stranger — but is the honest answer to a
 * question with no third participant.
 */
export function otherSide(link, senderId) {
  if (!link) return null
  if (link.coach_id === senderId) return link.client_id ?? null
  if (link.client_id === senderId) return link.coach_id ?? null
  return null
}

/** The kinds a client may switch off, so a settings screen cannot offer one that does nothing. */
export const NOTIFY_KINDS = Object.keys(KINDS)
