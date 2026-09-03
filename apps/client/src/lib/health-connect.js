/* Health Connect, on the Android build — docs/WEARABLES.md M4.
 *
 * The hub rather than the watch, for the fourth time and for the same reason: nearly every
 * device sold writes here, so one read reaches Zepp, Samsung Health, Mi Fitness, Garmin
 * Connect, Polar Flow and Fitbit without a line of vendor code, an OAuth flow against a company
 * whose signup sanctions break, or a contract to maintain as somebody's API drifts.
 *
 * ## Why this one is allowed in the native build at all
 *
 * MOBILE.md promises the Android flavour never talks to a backend and that state never leaves
 * the device. This is a local system read — the OS hands over rows it already holds, nothing
 * goes out — so the promise holds exactly, and it is worth saying in the Bazaar listing rather
 * than leaving somebody to infer it from a permission dialog.
 *
 * On Android 14 and later Health Connect is part of the OS: package
 * `com.google.android.apps.healthdata`, in Settings, not uninstallable, no Play Store involved.
 * That last clause is the whole reason this is viable for a project that ships through Cafe
 * Bazaar and Myket. On 13 and below it is a Play Store app, so coverage is partial today and
 * improves on its own as devices turn over — `showStore()` is the one place that dependency
 * surfaces, and it is a link somebody may not be able to follow.
 *
 * Everything that turns a session into something GymYar can hold lives in `@gymyar/domain`, so
 * it is testable without an Android device anywhere near it. This file is the plugin and the
 * permissions and nothing else.
 */
import { MOBILE } from './mobile.js'
import { healthConnectImport } from '@gymyar/domain'

/* What is asked for, and nothing beyond it.
 *
 * Sessions and the heart rate inside them. Not steps, not calories, not the route — the app has
 * nowhere to put any of those, and a permission requested for a screen that does not exist is
 * one a reviewer is right to ask about and a user is right to refuse. `READ_EXERCISE_ROUTE` in
 * particular is somebody's map of where they run, which we would be collecting for nothing. */
const PERMISSIONS = ['READ_WORKOUTS', 'READ_HEART_RATE']

/* Loaded on demand, and gated on the raw env expression rather than on `MOBILE`.
 *
 * That looks like a pointless duplication of the constant in mobile.js and is not. Vite
 * substitutes `import.meta.env.VITE_MOBILE` with a literal *here*, so this whole ternary is
 * constant-folded and the plugin leaves the web build. Importing `MOBILE` instead does not
 * achieve it: the constant is computed in another module, and Rollup will not propagate a
 * boolean across a module boundary far enough to drop a dynamic import behind it.
 *
 * Neither will it reason across a call boundary — a bare `import()` inside a function whose
 * callers all check `MOBILE` first is still emitted, and ships a native plugin's web shim to
 * every browser that can never use it. Both of those were measured rather than assumed; see
 * the commit that added this. */
const plugin = () => (import.meta.env.VITE_MOBILE === '1'
  ? import('capacitor-health').then(m => m.Health)
  : Promise.reject(new Error('Health Connect is native-only')))

/** Whether this build could reach Health Connect at all. Decides whether the UI offers it. */
export const healthConnectPossible = () => MOBILE

/**
 * Is the hub actually there?
 *
 * False on an Android 13 phone that has never installed it, which is a real answer and not an
 * error — `showStore()` is what to offer next.
 */
export async function healthConnectAvailable() {
  if (!MOBILE) return false
  try {
    const Health = await plugin()
    const { available } = await Health.isHealthAvailable()
    return !!available
  } catch { return false }
}

/* Health Connect answers a permission query with a list of objects rather than one map, so this
 * flattens it and reports whether *everything* asked for was granted. Partial is not usable:
 * sessions without heart rate would silently produce sessions with no heart rate, which reads
 * as "your watch recorded none". */
const allGranted = res => {
  const flat = Object.assign({}, ...(res?.permissions || []))
  return PERMISSIONS.every(p => flat[p] === true)
}

export async function healthConnectGranted() {
  if (!MOBILE) return false
  try {
    const Health = await plugin()
    return allGranted(await Health.checkHealthPermissions({ permissions: PERMISSIONS }))
  } catch { return false }
}

/**
 * Ask. Must come from a tap — the OS puts its own sheet up.
 *
 * Android allows an app only a couple of prompts before it stops showing them and the person
 * has to go into the Health Connect app themselves, which is why `openSettings` exists and why
 * the sheet offers it once this has been refused.
 */
export async function requestHealthConnect() {
  const Health = await plugin()
  return allGranted(await Health.requestHealthPermissions({ permissions: PERMISSIONS }))
}

export const openSettings = () => plugin().then(H => H.openHealthConnectSettings()).catch(() => {})
export const showStore = () => plugin().then(H => H.showHealthConnectInPlayStore()).catch(() => {})

/* How far back a first read goes.
 *
 * A year, and not everything. Health Connect keeps whatever the phone has held since it was set
 * up, and the first read is the one somebody watches happen — a decade of sessions is a long
 * wait for a result they cannot check. Every read after this one starts where the last finished,
 * so the only cost of the bound is that a longer history needs the file import once, which is
 * the path that exists for exactly that.
 */
export const FIRST_READ_DAYS = 365

/**
 * Sessions since `since` (epoch ms), in the shape `mergeImport` takes.
 *
 * The end is *now* rather than the end of yesterday: a session that finished twenty minutes ago
 * is the one somebody has just opened the app to see.
 */
export async function readHealthConnect(since) {
  const Health = await plugin()
  const from = since || Date.now() - FIRST_READ_DAYS * 86400000
  const { workouts } = await Health.queryWorkouts({
    startDate: new Date(from).toISOString(),
    endDate: new Date().toISOString(),
    includeHeartRate: true,
    // Neither has anywhere to go. The route is also a permission this build does not hold.
    includeRoute: false,
    includeSteps: false
  })
  return healthConnectImport(workouts)
}
