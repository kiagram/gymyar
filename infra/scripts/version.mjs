#!/usr/bin/env node
/* One version, stamped everywhere it has to appear.
 *
 * A released app carries its version in four places that have no way of agreeing on their own:
 * the npm workspace, `android/app/build.gradle`, the Xcode project, and the PWA manifest. They
 * had drifted to three different answers — the workspace said 0.1.0, Android said 1.2.4 with
 * version code 5 (openGym's numbers, inherited at the fork and never reset), and iOS said 1.0.
 *
 * That is not cosmetic. `versionCode` must strictly increase or Android refuses to install an
 * update over an existing app, and a crash report that names a version nobody can map to a
 * commit is a crash report you cannot act on.
 *
 *   node infra/scripts/version.mjs             # stamp the current version everywhere
 *   node infra/scripts/version.mjs 1.1.0       # set a new version, then stamp it
 *   node infra/scripts/version.mjs --check     # verify everything agrees; exit 1 if not
 *
 * The root package.json is the source of truth. Everything else is generated from it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const at = (...p) => path.join(ROOT, ...p)

const FILES = {
  rootPkg: at('package.json'),
  clientPkg: at('apps', 'client', 'package.json'),
  gradle: at('apps', 'client', 'android', 'app', 'build.gradle'),
  pbxproj: at('apps', 'client', 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'),
  manifest: at('apps', 'client', 'public', 'manifest.json')
}

const read = f => readFileSync(f, 'utf8')

/**
 * Android's integer version code, derived rather than tracked separately.
 *
 * `major * 10000 + minor * 100 + patch` — monotonic for any version that only ever goes up,
 * and readable back to the semver at a glance (10203 is 1.2.3). Caps each part at 99, which
 * is a limit worth having: a 100th patch release means the scheme was the wrong shape.
 */
export function versionCode(version) {
  const [major, minor, patch] = parse(version)
  if (minor > 99 || patch > 99) {
    throw new Error(`${version}: minor and patch must each stay under 100 for the version code scheme`)
  }
  return major * 10000 + minor * 100 + patch
}

function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) throw new Error(`not a plain semver version: ${version} (no pre-release or build suffix)`)
  return [+m[1], +m[2], +m[3]]
}

const currentVersion = () => JSON.parse(read(FILES.rootPkg)).version

/** What each file says right now, for --check and for reporting what changed. */
function readAll() {
  const gradle = read(FILES.gradle)
  const pbx = read(FILES.pbxproj)
  return {
    root: JSON.parse(read(FILES.rootPkg)).version,
    client: JSON.parse(read(FILES.clientPkg)).version,
    androidName: /versionName\s+"([^"]+)"/.exec(gradle)?.[1] ?? null,
    androidCode: Number(/versionCode\s+(\d+)/.exec(gradle)?.[1] ?? NaN),
    // Both build configurations, so a Debug that disagrees with Release is caught.
    iosNames: [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(m => m[1].trim()),
    iosBuilds: [...pbx.matchAll(/CURRENT_PROJECT_VERSION = ([^;]+);/g)].map(m => m[1].trim()),
    manifest: JSON.parse(read(FILES.manifest)).version ?? null
  }
}

function stamp(version) {
  const code = versionCode(version)
  const before = readAll()

  for (const key of ['rootPkg', 'clientPkg']) {
    const pkg = JSON.parse(read(FILES[key]))
    pkg.version = version
    writeFileSync(FILES[key], JSON.stringify(pkg, null, 2) + '\n')
  }

  writeFileSync(FILES.gradle, read(FILES.gradle)
    .replace(/versionCode\s+\d+/, `versionCode ${code}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`))

  writeFileSync(FILES.pbxproj, read(FILES.pbxproj)
    .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
    // iOS wants a build number that rises within a marketing version. The Android code works
    // for that too, and using one number keeps the two stores telling the same story.
    .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${code};`))

  const manifest = JSON.parse(read(FILES.manifest))
  manifest.version = version
  writeFileSync(FILES.manifest, JSON.stringify(manifest, null, 2) + '\n')

  return { before, after: readAll(), code }
}

/** Everything that disagrees with the root package.json, as sentences. */
function problems() {
  const v = currentVersion()
  const code = versionCode(v)
  const s = readAll()
  const out = []
  if (s.client !== v) out.push(`apps/client/package.json says ${s.client}`)
  if (s.androidName !== v) out.push(`android versionName is ${s.androidName}`)
  if (s.androidCode !== code) out.push(`android versionCode is ${s.androidCode}, expected ${code}`)
  for (const n of s.iosNames) if (n !== v) out.push(`ios MARKETING_VERSION is ${n}`)
  for (const b of s.iosBuilds) if (b !== String(code)) out.push(`ios CURRENT_PROJECT_VERSION is ${b}, expected ${code}`)
  if (s.manifest !== v) out.push(`manifest.json says ${s.manifest}`)
  return out
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('version.mjs')) {
  const arg = process.argv[2]

  if (arg === '--check') {
    const bad = problems()
    if (bad.length) {
      console.error(`Version drift — root package.json says ${currentVersion()}:`)
      for (const b of bad) console.error(`  ${b}`)
      console.error('\nRun: node infra/scripts/version.mjs')
      process.exit(1)
    }
    console.log(`${currentVersion()} (android/ios build ${versionCode(currentVersion())}) — everything agrees.`)
  } else {
    const version = arg || currentVersion()
    const { before, code } = stamp(version)
    console.log(`stamped ${version} (build ${code})`)
    if (before.root !== version) console.log(`  package.json      ${before.root} → ${version}`)
    if (before.androidName !== version || before.androidCode !== code) {
      console.log(`  android           ${before.androidName} (${before.androidCode}) → ${version} (${code})`)
    }
    if (before.iosNames[0] !== version) console.log(`  ios               ${before.iosNames[0]} → ${version}`)
    if (before.manifest !== version) console.log(`  manifest.json     ${before.manifest ?? '—'} → ${version}`)
  }
}
