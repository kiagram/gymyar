/* The limiter, on a bare Fastify app — no database, no routes but the ones here.
 *
 * The behaviour worth pinning is not "it returns 429 eventually". It is *who* the 429 lands on:
 * this product's users share carrier addresses, so a limit that counts by address would work
 * perfectly in a test and lock out a city in production. Most of what follows checks that two
 * people sharing one address still have separate budgets.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import crypto from 'node:crypto'
import { registerRateLimit, limit, BUCKETS } from './rate-limit.js'
import { config } from './config.js'

/* A signed session cookie for `uid`, made the way session.js makes one. The limiter verifies
 * the signature, so an unsigned guess would simply be counted as anonymous. */
const cookieFor = uid => {
  const payload = `${uid}:${Date.now() + 3600_000}:1`
  const mac = crypto.createHmac('sha256', config.secret).update(payload).digest('base64url')
  return `gymsid=${payload}.${mac}`
}

async function makeApp({ enabled = true } = {}) {
  const app = Fastify()
  await app.register(cookie)
  await registerRateLimit(app, { enabled })
  app.get('/api/health', async () => ({ ok: true }))
  app.get('/api/thing', async () => ({ ok: true }))
  app.post('/api/ai/programme', { config: limit('model.draft') }, async () => ({ ok: true }))
  app.post('/api/login/password', { config: limit('auth') }, async () => ({ ok: true }))
  await app.ready()
  return app
}

const hit = (app, opts) => app.inject({ method: 'GET', url: '/api/thing', ...opts })
const draft = (app, headers) => app.inject({ method: 'POST', url: '/api/ai/programme', headers, payload: {} })
const login = (app, email) =>
  app.inject({ method: 'POST', url: '/api/login/password', payload: { email, password: 'x' } })

describe('the expensive routes', () => {
  it('stops a caller once the model budget is spent', async () => {
    const app = await makeApp()
    const headers = { cookie: cookieFor('user-a') }
    const max = BUCKETS['model.draft'].max
    for (let i = 0; i < max; i++) {
      expect((await draft(app, headers)).statusCode).toBe(200)
    }
    expect((await draft(app, headers)).statusCode).toBe(429)
  })

  it('answers a 429 in the same shape as every other error', async () => {
    const app = await makeApp()
    const headers = { cookie: cookieFor('user-b') }
    for (let i = 0; i < BUCKETS['model.draft'].max; i++) await draft(app, headers)
    const res = await draft(app, headers)
    const body = res.json()
    // The client already knows how to read `{ error, code }` — a limiter that invented its own
    // shape would surface as an unexplained failure rather than a message.
    expect(body.code).toBe('rate_limited')
    expect(typeof body.error).toBe('string')
    expect(body.retryAfter).toBeGreaterThan(0)
  })

  it('does not spend the cheap budget on the expensive one', async () => {
    const app = await makeApp()
    const headers = { cookie: cookieFor('user-c') }
    for (let i = 0; i < BUCKETS['model.draft'].max; i++) await draft(app, headers)
    expect((await draft(app, headers)).statusCode).toBe(429)
    // An ordinary read is on a different, far larger bucket and is unaffected.
    expect((await hit(app, { headers })).statusCode).toBe(200)
  })
})

describe('two people behind one address', () => {
  it('gives them separate budgets', async () => {
    const app = await makeApp()
    const a = { cookie: cookieFor('user-1') }
    const b = { cookie: cookieFor('user-2') }
    for (let i = 0; i < BUCKETS['model.draft'].max; i++) await draft(app, a)
    expect((await draft(app, a)).statusCode).toBe(429)
    // Same test client, same address, different account — and it must still work. This is the
    // whole reason the key is the account.
    expect((await draft(app, b)).statusCode).toBe(200)
  })

  it('counts an unsigned cookie as nobody rather than as that user', async () => {
    const app = await makeApp()
    const forged = { cookie: 'gymsid=user-1:9999999999999:1.notarealmac' }
    // A forged cookie must not let someone drain another account's budget.
    for (let i = 0; i < BUCKETS['model.draft'].max; i++) await draft(app, forged)
    expect((await draft(app, forged)).statusCode).toBe(429)
    expect((await draft(app, { cookie: cookieFor('user-1') })).statusCode).toBe(200)
  })
})

describe('signing in', () => {
  it('limits attempts against one account', async () => {
    const app = await makeApp()
    for (let i = 0; i < BUCKETS.auth.max; i++) {
      expect((await login(app, 'target@x.test')).statusCode).toBe(200)
    }
    expect((await login(app, 'target@x.test')).statusCode).toBe(429)
  })

  it('does not lock everyone else out of their own accounts', async () => {
    const app = await makeApp()
    for (let i = 0; i < BUCKETS.auth.max; i++) await login(app, 'target@x.test')
    expect((await login(app, 'target@x.test')).statusCode).toBe(429)
    // Someone else on the same carrier address, signing in to their own account.
    expect((await login(app, 'neighbour@x.test')).statusCode).toBe(200)
  })

  it('treats the address as the subject when no account is named', async () => {
    const app = await makeApp()
    for (let i = 0; i < BUCKETS.auth.max; i++) {
      await app.inject({ method: 'POST', url: '/api/login/password', payload: {} })
    }
    const res = await app.inject({ method: 'POST', url: '/api/login/password', payload: {} })
    expect(res.statusCode).toBe(429)
  })

  it('is case- and space-insensitive about which account is being tried', async () => {
    const app = await makeApp()
    for (let i = 0; i < BUCKETS.auth.max; i++) await login(app, 'Target@X.test')
    expect((await login(app, '  target@x.test  ')).statusCode).toBe(429)
  })
})

describe('what is never limited', () => {
  it('leaves the health check alone', async () => {
    const app = await makeApp()
    // A container decides whether to keep running from this. Throttling it restarts the API.
    for (let i = 0; i < BUCKETS.default.max + 20; i++) {
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200)
    }
  })
})

describe('switched off', () => {
  it('limits nothing at all', async () => {
    const app = await makeApp({ enabled: false })
    const headers = { cookie: cookieFor('user-z') }
    for (let i = 0; i < BUCKETS['model.draft'].max + 5; i++) {
      expect((await draft(app, headers)).statusCode).toBe(200)
    }
  })
})

describe('the bucket table', () => {
  it('refuses a name it does not know', () => {
    // A typo in a route's config must fail at boot, not silently apply no limit.
    expect(() => limit('model.draftt')).toThrow(/unknown rate-limit bucket/)
  })

  it('gives every bucket a max and a window', () => {
    for (const [name, b] of Object.entries(BUCKETS)) {
      expect(b.max, name).toBeGreaterThan(0)
      expect(b.window, name).toBeGreaterThan(0)
    }
  })

  it('keeps the model buckets well below the general ceiling', () => {
    expect(BUCKETS['model.draft'].max).toBeLessThan(BUCKETS.default.max)
    expect(BUCKETS['model.parse'].max).toBeLessThan(BUCKETS.default.max)
  })
})
