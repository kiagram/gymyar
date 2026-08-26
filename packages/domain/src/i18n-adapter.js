/* Translation seam for the domain package.
 *
 * The domain logic is shared by the client (React + Vite), the API and the AI worker.
 * Only the client has a real i18n runtime — it lazy-loads locale packs through
 * `import.meta.glob` and re-renders via `useSyncExternalStore`, neither of which exists
 * on the server. So the domain never imports that runtime directly; it calls through
 * here, and whoever has a translator registers it at boot.
 *
 * Unregistered, `t` is the English identity with {0}-style interpolation intact — the
 * same fallback path the client's own `t` takes for an untranslated string, so server
 * output is correct English rather than placeholder keys.
 */

/* Every language this app ships, as the codes both sides key off.
 *
 * Here rather than in the client's `LANGS` because the server needs it too and has no business
 * importing a React module to get it. `LANGS` maps these to the names a person picks from,
 * which is presentation; this is the set, which is a fact about the build. A test in the client
 * asserts the two have not drifted.
 *
 * The server's use for it is narrow and worth stating: `users.locale` is what decides the
 * language an AI-written note comes back in, and it is written from a request. An allowlist is
 * what keeps that column a language rather than a string somebody chose.
 */
export const LOCALES = ['en', 'fa']

export const isLocale = code => LOCALES.includes(String(code || ''))

/* Which weekday each locale's week starts on, as a `getDay()` index.
 *
 * Here for the same reason `LOCALES` is: the server needs it too. A roster counting "this
 * week's habits" has to use the coach's week, and it learns which one that is from
 * `users.locale` — while the client learns it from the profile. Two copies of this map would
 * disagree the day somebody adds a locale to one of them, and the symptom would be a coach and
 * a client looking at different Saturdays.
 *
 * Only languages that differ from Monday are listed. Everything else was hardcoded to Monday
 * before this existed, so an omission keeps exactly what it did — and the ones that arguably
 * want Sunday (hi, ko, zh) are left alone deliberately rather than changed as a side effect. */
const WEEK_STARTS = { fa: 6 }

export const weekStartsFor = locale => WEEK_STARTS[String(locale || '').split('-')[0]] ?? 1

const fallback = {
  t: (s, ...args) => {
    let v = s
    for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', args[i])
    return v
  },
  dateLocale: () => 'en-GB',
  // Which weekday a week starts on, as a `getDay()` index. Monday is the default because it is
  // what every language this app shipped with was hardcoded to; a locale that starts its week
  // elsewhere — Saturday in Iran, Sunday in much of Asia and the Americas — says so here rather
  // than each grid working it out again.
  weekStartsOn: () => 1
}

let impl = fallback

/** Register a translator. Pass nothing to go back to English. */
export function setI18n(next) {
  impl = next ? { ...fallback, ...next } : fallback
}

export const t = (s, ...args) => impl.t(s, ...args)
export const dateLocale = () => impl.dateLocale()
export const weekStartsOn = () => impl.weekStartsOn()
