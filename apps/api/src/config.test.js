/* The two production guards docs/SELF_HOSTING.md section 5 promises, checked against the code.
 *
 * "SESSION_SECRET is required — the API refuses to start without a secret rather than inventing
 * one" is a sentence in a document, and config.js is evaluated once at import with whatever the
 * environment holds. So the check has to be a fresh process: import the module under
 * NODE_ENV=production with the variable unset and see whether it throws. An in-process test
 * would be reading the config this test runner already built.
 *
 * The rate-limit default is the other half of that section — "leave it on" is only advice if
 * the default is on — and its keying is pinned in rate-limit.test.js.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

const here = fileURLToPath(new URL('.', import.meta.url))

/* Runs `import('./config.js')` in a child with exactly the environment given — the parent's is
 * not inherited, so a SESSION_SECRET set for this test run cannot leak in and make the guard
 * look like it fired when it never had to. */
function boot(env) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', 'await import("./config.js"); console.log("booted")'],
      { cwd: here, env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
    return { ok: true }
  } catch (e) {
    return { ok: false, stderr: String(e.stderr) }
  }
}

describe('SESSION_SECRET in production', () => {
  it('refuses to boot without one', () => {
    const r = boot({ NODE_ENV: 'production' })
    expect(r.ok).toBe(false)
    expect(r.stderr).toMatch(/SESSION_SECRET must be set in production/)
  })

  it('treats an empty value as unset — .env.example ships `SESSION_SECRET=`', () => {
    const r = boot({ NODE_ENV: 'production', SESSION_SECRET: '' })
    expect(r.ok).toBe(false)
    expect(r.stderr).toMatch(/SESSION_SECRET must be set/)
  })

  it('boots with one', () => {
    expect(boot({ NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(64) }).ok).toBe(true)
  })

  it('invents one outside production, which is the laptop case', () => {
    expect(boot({ NODE_ENV: 'development' }).ok).toBe(true)
    expect(boot({}).ok).toBe(true)
  })
})

describe('RATE_LIMIT', () => {
  it('is on by default — the document says "leave it on", and that needs a default of on', () => {
    // Read from the config this process already built rather than a child: the flag is a pure
    // function of the variable, and this run's environment says whether the default applied.
    const raw = process.env.RATE_LIMIT || 'on'
    expect(config.rateLimit).toBe(!/^(0|false|no|off)$/i.test(raw))
    if (!process.env.RATE_LIMIT) expect(config.rateLimit).toBe(true)
  })
})
