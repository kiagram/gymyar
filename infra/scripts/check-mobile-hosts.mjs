#!/usr/bin/env node
/* The check behind the native app's privacy declaration.
 *
 * Every store is told the same thing about the mobile build: it collects nothing and transmits
 * nothing, and the only outbound request fetches exercise media from a CDN. That is true today
 * (see docs/store/privacy.md), and it is exactly the kind of true that one added import
 * silently ends — an analytics SDK, a font from Google, a crash reporter somebody added to
 * debug one thing and left in.
 *
 * So: build the mobile bundle, list every host that appears in it, and fail on anything not
 * accounted for. Failing is the point. A new host is not necessarily a leak — most of the
 * allowed ones below are link targets and error-message URLs that are never fetched — but it
 * does mean the declaration has stopped describing the binary, and somebody has to look.
 *
 *   node infra/scripts/check-mobile-hosts.mjs [dist-dir]
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Hosts allowed to appear, and why each one is not a request.
 *
 * Adding to this list is a deliberate act. The `why` is not decoration — it is what the next
 * person reads when they are deciding whether a store declaration is still honest.
 */
export const ALLOWED = {
  'cdn.jsdelivr.net': 'exercise images and animations — the one real outbound request',
  'gitea.com': 'the openGym attribution link in Settings; an <a href>, followed only if tapped',
  'github.com': 'a polyfill suggestion inside a library warning message',
  'react.dev': 'a URL in a React error message',
  'reactrouter.com': 'a URL in a React Router error message',
  'www.w3.org': 'the SVG xmlns namespace — not an address',
  'localhost': "React Router's internal base for parsing relative paths"
}

const HOST = /https?:\/\/([a-z0-9.-]+)/gi

/** Every host mentioned anywhere in the built JavaScript. */
export function hostsIn(dir) {
  const found = new Map()
  for (const file of readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const body = readFileSync(path.join(dir, file), 'utf8')
    for (const m of body.matchAll(HOST)) {
      const host = m[1].toLowerCase().replace(/\.$/, '')
      if (!found.has(host)) found.set(host, file)
    }
  }
  return found
}

export const unexpected = hosts =>
  [...hosts.keys()].filter(h => !Object.hasOwn(ALLOWED, h))

if (process.argv[1]?.endsWith('check-mobile-hosts.mjs')) {
  const dir = process.argv[2] || path.join(ROOT, 'apps', 'client', 'dist', 'assets')
  if (!existsSync(dir)) {
    console.error(`No build at ${dir}. Build the mobile bundle first:`)
    console.error('  cd apps/client && VITE_MOBILE=1 npx vite build')
    process.exit(1)
  }

  const hosts = hostsIn(dir)
  const bad = unexpected(hosts)

  if (bad.length) {
    console.error('Hosts in the mobile bundle that nothing accounts for:\n')
    for (const h of bad) console.error(`  ${h}   (first seen in ${hosts.get(h)})`)
    console.error(`
The native app's store listing declares that it collects and transmits nothing.
Work out what this is. If it is fetched at runtime, the declaration in
docs/store/privacy.md is now false and has to change before the next submission.
If it is only a link or an error string, add it to ALLOWED in this file with a
note saying why.`)
    process.exit(1)
  }

  console.log(`${hosts.size} hosts in the mobile bundle, all accounted for:`)
  for (const [h, file] of hosts) console.log(`  ${h.padEnd(20)} ${ALLOWED[h]}`)
}
