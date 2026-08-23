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

const fallback = {
  t: (s, ...args) => {
    let v = s
    for (let i = 0; i < args.length; i++) v = v.replaceAll('{' + i + '}', args[i])
    return v
  },
  dateLocale: () => 'en-GB'
}

let impl = fallback

/** Register a translator. Pass nothing to go back to English. */
export function setI18n(next) {
  impl = next ? { ...fallback, ...next } : fallback
}

export const t = (s, ...args) => impl.t(s, ...args)
export const dateLocale = () => impl.dateLocale()
