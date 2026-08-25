import { create } from 'zustand'
import { api } from '../lib/api.js'
import { localTZ } from '@gymbuddy/domain'
import { registerCustom } from '@gymbuddy/domain'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { detectLang } from '../lib/i18n.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'
import { sync as syncDelta, mergeChanges, resetSync, getCursor } from '../lib/sync.js'

const KEY = 'gym_state_v1'
export const DEF = {
  // lang: the device's language on a first run, the profile's own choice on every run after
  // — saved state is overlaid on this. See detectLang.
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: detectLang(),
  theme: 'dark', accent: 'red', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null
}
const clone = o => JSON.parse(JSON.stringify(o))

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return Object.assign(clone(DEF), JSON.parse(raw))
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length)

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null
  let syncing = null

  // Mobile build: mirror the state into a file in the app's data directory (survives WebView
  // storage eviction) and keep the native reminder schedule in step with the weekly plan.
  const nativePersist = () => {
    clearTimeout(saveTm)
    saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
  }

  const persist = (S, push = true) => {
    S._ts = Date.now()
    registerCustom(S.customEx)
    localStorage.setItem(KEY, JSON.stringify(S))
    set({ S })
    if (MOBILE) nativePersist()
    if (push && get().user) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
  }

  // A setting changed right before switching away/closing the tab must not get lost mid-debounce
  // (e.g. setting the reminder time then immediately backgrounding to test it). On mobile the
  // same applies to the file mirror — backgrounding is often the last thing before the OS
  // kills the app.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return
    if (MOBILE && saveTm) {
      clearTimeout(saveTm)
      saveTm = null
      nativeSave(get().S)
    }
    if (pushTm) {
      clearTimeout(pushTm)
      pushTm = null
      get().pushState()
    }
  })

  // Everything a sign-out leaves behind on this device, whichever way it was triggered.
  const clearLocalSession = () => {
    get().setUser(null)
    localStorage.removeItem('gym_guest')
    localStorage.removeItem('gym_dirty')
    localStorage.removeItem(KEY)
    // The cursor and snapshot describe what *that account* had synced. Leaving them behind
    // would have the next person to sign in on this device push someone else's history as
    // their own delta.
    resetSync()
    persist(clone(DEF), false)
  }

  return {
    S: (() => { const s = loadState(); registerCustom(s.customEx); return s })(),
    user: (() => { try { return JSON.parse(localStorage.getItem('gym_user')) || null } catch { return null } })(),
    ready: false,
    syncedAt: null,
    syncError: null,

    // Mutate a draft of S via producer fn, then persist + schedule sync.
    update(mut, push = true) {
      const S = clone(get().S)
      mut(S)
      persist(S, push)
    },
    replaceState(S, push = false) { persist(clone(S), push) },

    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) { if (v) localStorage.setItem('gym_guest', '1'); else localStorage.removeItem('gym_guest'); set({}) },

    setUser(u) {
      if (u) { localStorage.setItem('gym_user', JSON.stringify(u)); localStorage.removeItem('gym_guest') }
      else localStorage.removeItem('gym_user')
      set({ user: u })
    },

    // One sync: push what this device has changed, pull what it has not seen. Both directions
    // are deltas — the whole account no longer moves on every save.
    //
    // `full` starts from scratch: no cursor, no snapshot, ask for everything. Used on first
    // sign-in on a device, and as the recovery path if a cursor is ever lost.
    async syncNow({ full = false } = {}) {
      if (!get().user) return null
      clearTimeout(pushTm)
      pushTm = null
      if (syncing) return syncing            // never two in flight; the second would race the first
      syncing = (async () => {
        try {
          const report = await syncDelta(get().S, changes => {
            // `active` is device-local by design and never crosses the wire, so a merge must
            // not drop the session this device is in the middle of.
            const activeHere = get().S.active
            const merged = mergeChanges(get().S, changes)
            if (activeHere) merged.active = activeHere
            persist(Object.assign(clone(DEF), merged), false)
            return get().S
          }, { full })
          localStorage.removeItem('gym_dirty')
          set({ syncedAt: Date.now(), syncError: null })
          return report
        } catch (e) {
          // Offline is the common case and not worth surfacing; the delta is still in the
          // difference between state and snapshot and goes out on the next attempt.
          localStorage.setItem('gym_dirty', '1')
          set({ syncError: e.status === 401 ? 'signed-out' : 'offline' })
          if (e.status === 401) get().setUser(null)
          return null
        } finally {
          syncing = null
        }
      })()
      return syncing
    },

    // Kept so the rest of the app can call it by the old name; a push now implies a sync.
    async pushState() { return get().syncNow() },
    async pullState() { return get().syncNow() },

    async signOut() {
      try { await get().pushState(); await api('/api/logout', { method: 'POST', body: '{}' }) } catch (e) { /* */ }
      clearLocalSession()
    },

    // "Sign out everywhere": the server bumps this profile's session version, which kills every
    // session it has on any device — this browser included, so the app has to end up exactly
    // where a normal signOut leaves it. Unlike signOut the request is NOT swallowed: if it fails
    // the sessions elsewhere are all still valid, and wiping this device's copy of the data
    // would sign the user out of the one place the bump didn't reach. Caller reports the error.
    async signOutAll() {
      await get().pushState()   // never throws — stores gym_dirty and moves on when offline
      await api('/api/logout/all', { method: 'POST', body: '{}' })
      clearLocalSession()
    },

    // Demo build only: drop the seeded example profile back in (Settings → "Reset demo data").
    // Dynamic import so the generator never ships in a self-hosted bundle.
    async resetDemo() {
      const { buildDemoState } = await import('@gymbuddy/domain/demo-seed.js')
      localStorage.removeItem('gym_dirty')
      persist(Object.assign(clone(DEF), buildDemoState()), false)
    },

    // Boot: ask the server who we are, then pull.
    async boot() {
      // Mobile build: no backend either — restore from the file mirror (the durable copy;
      // localStorage may have been evicted since the last run) and go straight in.
      if (MOBILE) {
        const saved = await nativeLoad()
        const S = get().S
        if (saved && (!hasData(S) || (saved._ts || 0) >= (S._ts || 0))) {
          persist(Object.assign(clone(DEF), saved), false)
        } else if (hasData(S)) {
          nativeSave(S)   // first run after an update from a file-less version: seed the mirror
        }
        get().setGuest(true)
        syncReminder(get().S)
        set({ ready: true })
        return
      }
      // Demo build (GitHub Pages): no backend at all — seed once, stay in guest mode.
      if (DEMO) {
        if (!localStorage.getItem(DEMO_SEEDED)) {
          localStorage.setItem(DEMO_SEEDED, '1')
          await get().resetDemo()
        }
        get().setGuest(true)
        set({ ready: true })
        return
      }
      try {
        const me = await api('/api/me')
        const switched = get().user && get().user.id !== me.user.id
        get().setUser(me.user)
        // A different account on this device starts clean rather than inheriting a cursor
        // and snapshot that belong to someone else.
        if (switched) resetSync()
        await get().syncNow({ full: switched || !getCursor() })
        // Re-stamp the reminder's timezone on every load — keeps it correct if you're travelling,
        // without needing to revisit Settings.
        const tz = localTZ()
        if (get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      } catch (e) {
        if (e.status === 401) get().setUser(null)
      }
      set({ ready: true })
    }
  }
})

export { hasData }
