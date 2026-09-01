// The repository this project lives in — the repo root, no trailing slash. Every source
// link on the site is hidden while this is empty, so a fork that has not published yet
// shows no dead links rather than links into somebody else's tree. See docs/PUBLISHING.md.
const REPO = 'https://github.com/kiagram/gymyar'

// Paths use /blob/HEAD/, which GitHub resolves to whatever the default branch is. Not
// /blob/main/: the main branch here is the openGym import, kept as the attribution trail,
// so a link into it serves openGym's CHANGELOG rather than this project's. HEAD also
// survives the default branch being renamed, which a hardcoded name does not.
//
// Anything carrying data-repo is a link into the repository: the attribute is the path to
// append. Empty attribute means the repo root. With REPO unset they stay hidden rather than
// pointing somewhere wrong — a dead link to a repository that does not exist yet is worse
// than no link, and this site is served without a build step, so this is where that lives.
for (const el of document.querySelectorAll('[data-repo]')) {
  if (!REPO) continue
  el.href = REPO + el.dataset.repo
  el.rel = 'noopener'
  el.hidden = false
}

/* ── Links that still point at where the app used to be ──────────────────────────────────
 *
 * The app was served at `/` before the project site took that address, and its routes are
 * after the `#` — so a bookmark, a shared link or an installed PWA's start URL from before
 * the move arrives here as `/#/stats`. The server cannot see a fragment, so this is the only
 * layer that can do anything about it.
 *
 * Only `#/` counts. Every anchor on this site is a word (`#pricing`, `#download`), and none
 * of them can be mistaken for a route. `replace` rather than `assign`: the page the visitor
 * meant to open should be the one the back button returns to. */
if (location.hash.startsWith('#/')) {
  location.replace('/app/' + location.hash)
}

/* ── The numbers, from the instance rather than from a brochure ──────────────────────────
 *
 * `#instance` ships hidden and stays hidden unless the API answers with a session in it. That
 * covers the three cases that are not "a running instance with people on it": the site served
 * on its own with no backend behind it, an instance whose owner set `PUBLIC_STATS=off` (a 404
 * here), and a brand new one where every counter is honestly zero. A strip of dashes, or of
 * zeroes, says less than no strip at all.
 *
 * Nothing here is required for the page to be correct — it is markup that reveals itself —
 * so a failure is silent by design. */
const stats = document.getElementById('instance')
if (stats) {
  // Persian digits in Persian prose, Latin everywhere else: the same rule the pages under
  // /fa/ already follow for every number written into them by hand.
  const lang = document.documentElement.lang === 'fa' ? 'fa' : 'en'
  const fmt = n => { try { return new Intl.NumberFormat(lang).format(n) } catch { return String(n) } }

  fetch('/api/public/stats', { headers: { accept: 'application/json' } })
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(({ stats: s }) => {
      // Nobody has trained here yet. Say nothing rather than a row of zeroes.
      if (!s || !s.workouts) return
      const shown = {
        athletes: s.athletes,
        coaches: s.coaches,
        workouts: s.workouts,
        sets: s.sets,
        // Kilograms on the wire, tonnes on the page. A real instance passes a million
        // kilograms inside its first year and "1,240" over "tonnes lifted" is a number a
        // person can picture, which "1,240,000" over "kg" is not.
        tonnes: Math.round(s.volumeKg / 1000)
      }
      for (const el of stats.querySelectorAll('[data-stat]')) {
        const v = shown[el.dataset.stat]
        if (v != null) el.textContent = fmt(v)
      }
      stats.hidden = false
    })
    .catch(() => { /* no instance behind this site, or it publishes nothing. Leave it hidden. */ })
}
