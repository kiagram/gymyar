/* The gateway adapter against a fake fetch. Nothing here reaches Zarinpal.
 *
 * The cases worth having are the ones that cost money when they are wrong: 101 read as a
 * failure (a paid subscription refused), a retry storm on a real refusal (money taken twice),
 * and the amount not being the stored one (a cheap authority buying an expensive plan).
 */
import { describe, it, expect, vi } from 'vitest'
import { zarinpal, ZarinpalError } from './zarinpal.js'

const ok = data => ({ data, errors: [] })
const err = (code, message = 'nope') => ({ data: [], errors: { code, message } })

/** A fetch that answers each call from a queue, and records what it was asked. */
const fakeFetch = (...responses) => {
  const calls = []
  const queue = [...responses]
  const impl = vi.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    const next = queue.shift() ?? { status: 500, json: {} }
    if (next instanceof Error) throw next
    return {
      ok: (next.status ?? 200) < 400,
      status: next.status ?? 200,
      text: async () => (typeof next.json === 'string' ? next.json : JSON.stringify(next.json))
    }
  })
  impl.calls = calls
  return impl
}

const gw = (fetchImpl, opts = {}) =>
  zarinpal({ merchantId: 'm-1', sandbox: true, fetchImpl, timeoutMs: 500, ...opts })

describe('configuration', () => {
  it('refuses to exist without a merchant id', () => {
    expect(() => zarinpal({})).toThrow(/merchantId/)
  })

  it('refuses a currency that is neither Rial nor Toman', () => {
    expect(() => zarinpal({ merchantId: 'm', currency: 'USD' })).toThrow(/unknown currency/)
  })

  it('points at the sandbox host when asked', async () => {
    const f = fakeFetch({ json: ok({ code: 100, authority: 'A1' }) })
    await gw(f).request({ amount: 1000, description: 'x', callbackUrl: 'http://cb' })
    expect(f.calls[0].url).toContain('sandbox.zarinpal.com')
  })

  it('points at the live host by default', async () => {
    const f = fakeFetch({ json: ok({ code: 100, authority: 'A1' }) })
    await zarinpal({ merchantId: 'm', fetchImpl: f }).request({
      amount: 1000, description: 'x', callbackUrl: 'http://cb'
    })
    expect(f.calls[0].url).toContain('payment.zarinpal.com')
  })
})

describe('request', () => {
  it('sends the amount, currency and callback, and returns somewhere to send the payer', async () => {
    const f = fakeFetch({ json: ok({ code: 100, authority: 'A-123' }) })
    const out = await gw(f).request({
      amount: 1_490_000, description: 'GymYar coaching — 1 month', callbackUrl: 'http://x/cb'
    })

    expect(f.calls[0].body).toMatchObject({
      merchant_id: 'm-1', amount: 1_490_000, currency: 'IRR', callback_url: 'http://x/cb'
    })
    expect(out.authority).toBe('A-123')
    expect(out.startUrl).toContain('/pg/StartPay/A-123')
  })

  it('sends the currency it was configured with, not the terminal default', async () => {
    const f = fakeFetch({ json: ok({ code: 100, authority: 'A1' }) })
    await gw(f, { currency: 'IRT' }).request({ amount: 149_000, description: 'x', callbackUrl: 'http://cb' })
    expect(f.calls[0].body.currency).toBe('IRT')
  })

  it('omits metadata entirely when there is nothing to put in it', async () => {
    const f = fakeFetch({ json: ok({ code: 100, authority: 'A1' }) })
    await gw(f).request({ amount: 1000, description: 'x', callbackUrl: 'http://cb' })
    expect(f.calls[0].body).not.toHaveProperty('metadata')
  })

  it('includes an email when there is one', async () => {
    const f = fakeFetch({ json: ok({ code: 100, authority: 'A1' }) })
    await gw(f).request({ amount: 1000, description: 'x', callbackUrl: 'http://cb', email: 'a@b.c' })
    expect(f.calls[0].body.metadata).toEqual({ email: 'a@b.c' })
  })

  it('rejects a non-integer amount before spending a round trip', async () => {
    const f = fakeFetch()
    await expect(gw(f).request({ amount: 10.5, description: 'x', callbackUrl: 'http://cb' }))
      .rejects.toThrow(/positive integer/)
    expect(f).not.toHaveBeenCalled()
  })

  it('turns a gateway refusal into a named error', async () => {
    const f = fakeFetch({ json: err(-11) })
    await expect(gw(f).request({ amount: 1000, description: 'x', callbackUrl: 'http://cb' }))
      .rejects.toThrow(/not active/)
  })

  it('refuses a success that carries no authority', async () => {
    const f = fakeFetch({ json: ok({ code: 100 }) })
    await expect(gw(f).request({ amount: 1000, description: 'x', callbackUrl: 'http://cb' }))
      .rejects.toThrow(/did not return an authority/)
  })

  it('surfaces a non-JSON response rather than guessing at it', async () => {
    const f = fakeFetch({ status: 200, json: '<html>maintenance</html>' })
    await expect(gw(f).request({ amount: 1000, description: 'x', callbackUrl: 'http://cb' }))
      .rejects.toThrow(/not JSON/)
  })
})

describe('verify', () => {
  it('reads 100 as paid and returns the receipt', async () => {
    const f = fakeFetch({ json: ok({ code: 100, ref_id: 987654, card_pan: '6037****1234' }) })
    const out = await gw(f).verify({ amount: 1000, authority: 'A1' })

    expect(out).toMatchObject({ ok: true, alreadyVerified: false, refId: '987654', code: 100 })
    expect(out.cardPan).toBe('6037****1234')
  })

  it('reads 101 as paid too — this is the second callback, not a failure', async () => {
    const f = fakeFetch({ json: ok({ code: 101, ref_id: 987654 }) })
    const out = await gw(f).verify({ amount: 1000, authority: 'A1' })

    expect(out.ok).toBe(true)
    expect(out.alreadyVerified).toBe(true)
    // The same receipt as the first time, which is what lets the unique index catch it.
    expect(out.refId).toBe('987654')
  })

  it('sends the amount it was given, so the gateway can catch a tampered callback', async () => {
    const f = fakeFetch({ json: ok({ code: 100, ref_id: 1 }) })
    await gw(f).verify({ amount: 12_900_000, authority: 'A1' })
    expect(f.calls[0].body).toEqual({ merchant_id: 'm-1', amount: 12_900_000, authority: 'A1' })
  })

  it('reports an amount mismatch as a refusal rather than throwing', async () => {
    const f = fakeFetch({ json: err(-50) })
    const out = await gw(f).verify({ amount: 1000, authority: 'A1' })

    expect(out.ok).toBe(false)
    expect(out.code).toBe(-50)
    expect(out.reason).toMatch(/does not match/)
  })

  it('reports an incomplete payment as a refusal', async () => {
    const f = fakeFetch({ json: err(-51) })
    expect((await gw(f).verify({ amount: 1000, authority: 'A1' })).ok).toBe(false)
  })

  it('refuses to verify nothing', async () => {
    await expect(gw(fakeFetch()).verify({ amount: 1, authority: '' })).rejects.toThrow(/authority/)
  })
})

describe('retrying', () => {
  it('retries a 503 and succeeds on the second try', async () => {
    const f = fakeFetch({ status: 503, json: {} }, { json: ok({ code: 100, ref_id: 5 }) })
    const out = await gw(f).verify({ amount: 1000, authority: 'A1' })

    expect(out.ok).toBe(true)
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('does not retry a refusal — the answer was "no", asking again does not change it', async () => {
    const f = fakeFetch({ json: err(-51) }, { json: ok({ code: 100, ref_id: 5 }) })
    const out = await gw(f).verify({ amount: 1000, authority: 'A1' })

    expect(out.ok).toBe(false)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('gives up after three attempts rather than hammering the gateway', async () => {
    const f = fakeFetch({ status: 502, json: {} }, { status: 502, json: {} }, { status: 502, json: {} })
    await expect(gw(f).verify({ amount: 1000, authority: 'A1' })).rejects.toThrow(ZarinpalError)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('retries a dropped connection', async () => {
    const f = fakeFetch(new TypeError('fetch failed'), { json: ok({ code: 100, ref_id: 5 }) })
    expect((await gw(f).verify({ amount: 1000, authority: 'A1' })).ok).toBe(true)
  })
})

describe('unverified', () => {
  it('lists the authorities the gateway thinks are outstanding', async () => {
    const f = fakeFetch({ json: ok({ authorities: [{ authority: 'A1', amount: 1000 }] }) })
    expect(await gw(f).unverified()).toEqual([{ authority: 'A1', amount: 1000 }])
  })

  it('reads -9 as "nothing pending" rather than as a fault', async () => {
    const f = fakeFetch({ json: err(-9) })
    expect(await gw(f).unverified()).toEqual([])
  })

  it('still throws on a real fault', async () => {
    const f = fakeFetch({ json: err(-11) })
    await expect(gw(f).unverified()).rejects.toThrow(/not active/)
  })
})
