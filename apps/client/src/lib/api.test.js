/* The one thing about `api()` that is not obvious from reading it.
 *
 * A `Content-Type: application/json` on a request with no body is refused by Fastify before
 * any route sees it — `FST_ERR_CTP_EMPTY_JSON_BODY`, a 400 that looks like a bug in whatever
 * was being deleted. Every `DELETE` this client makes has no body, so an unconditional header
 * broke all of them at once and none of the API tests could see it: the test client sends no
 * header when it sends no payload, so it was exercising a request the browser never made.
 *
 * Hence this file. It asserts the shape of the request rather than the response, which is the
 * part the server tests cannot reach.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { api } from './api.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

/** Records what `api()` asked for, and answers `{}`. */
function spyFetch() {
  const calls = []
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  })
  return calls
}

describe('the request api() actually makes', () => {
  it('sends no content type when there is no body', async () => {
    const calls = spyFetch()
    await api('/api/me/phone', { method: 'DELETE' })
    expect(calls[0].init.headers).toEqual({})
  })

  it('sends one when there is', async () => {
    const calls = spyFetch()
    await api('/api/phone/start', { method: 'POST', body: JSON.stringify({ phone: '+989123456789' }) })
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('leaves a plain GET alone', async () => {
    const calls = spyFetch()
    await api('/api/config')
    expect(calls[0].init.headers).toEqual({})
  })

  it('carries the server’s code and details onto the error, not just the message', async () => {
    // A 402 says *why* in `details`, and a screen with only the sentence cannot tell an ended
    // trial from a lapsed subscription. Same mechanism carries `name_required` and the
    // remaining-guesses count on the phone flow.
    globalThis.fetch = vi.fn(async () => ({
      ok: false, status: 401,
      json: async () => ({ error: 'that code is wrong or has expired', code: 'bad_code', details: { attemptsLeft: 3 } })
    }))
    await expect(api('/api/phone/verify', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      message: 'that code is wrong or has expired',
      status: 401,
      code: 'bad_code',
      details: { attemptsLeft: 3 }
    })
  })
})
