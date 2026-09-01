import { describe, it, expect, vi, afterEach } from 'vitest'
import { smsFor, smsEnabled, smsBrand, codeMessage } from './index.js'
import { national, SmsError } from './http.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks() })

/* A gateway that records what it was asked and answers with whatever the test hands it. */
const stubFetch = body => {
  const calls = []
  globalThis.fetch = vi.fn(async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => body }
  })
  return calls
}

describe('choosing a transport', () => {
  it('is off with nothing configured, and says so', () => {
    expect(smsFor({ env: {} })).toBe(null)
    expect(smsEnabled({})).toBe(false)
    expect(smsEnabled({ SMS_TRANSPORT: 'off' })).toBe(false)
    expect(smsEnabled({ SMS_TRANSPORT: 'kavenegar' })).toBe(true)
  })

  it('refuses a name it does not know rather than falling back to silence', () => {
    expect(() => smsFor({ env: { SMS_TRANSPORT: 'twilio' } })).toThrow(/unknown SMS_TRANSPORT/)
  })

  it('refuses a gateway with no key at build time, not at send time', () => {
    expect(() => smsFor({ env: { SMS_TRANSPORT: 'kavenegar' } })).toThrow(/SMS_KAVENEGAR_KEY/)
    expect(() => smsFor({ env: { SMS_TRANSPORT: 'smsir' } })).toThrow(/SMS_SMSIR_KEY/)
  })

  it('writes to the log instead of sending', async () => {
    const lines = []
    const t = smsFor({ env: { SMS_TRANSPORT: 'log' }, log: { info: (o, m) => lines.push([o, m]) } })
    const r = await t.send({ to: '+989123456789', code: '123456', text: 'hi' })
    expect(r).toEqual({ accepted: true, transport: 'log' })
    expect(lines[0][0].code).toBe('123456')
  })
})

describe('the receptor a gateway will accept', () => {
  it('is the national form, whatever was stored', () => {
    expect(national('+989123456789')).toBe('09123456789')
    expect(national('09123456789')).toBe('09123456789')
  })
  it('refuses to hand a gateway something that is not a mobile number', () => {
    expect(() => national('+12125551234')).toThrow(SmsError)
  })
})

describe('kavenegar', () => {
  const env = { SMS_TRANSPORT: 'kavenegar', SMS_KAVENEGAR_KEY: 'k-1', SMS_KAVENEGAR_TEMPLATE: 'gymyar-otp' }

  it('sends the code through the registered pattern', async () => {
    const calls = stubFetch({ return: { status: 200 }, entries: [{ messageid: 77 }] })
    const r = await smsFor({ env }).send({ to: '+989123456789', code: '123456', text: 'unused' })

    expect(calls[0].url).toContain('/v1/k-1/verify/lookup.json')
    const sent = Object.fromEntries(new URLSearchParams(calls[0].init.body))
    expect(sent).toEqual({ receptor: '09123456789', token: '123456', template: 'gymyar-otp' })
    expect(r).toMatchObject({ accepted: true, transport: 'kavenegar', id: 77 })
  })

  it('falls back to a plain message when no pattern is registered yet', async () => {
    const calls = stubFetch({ return: { status: 200 }, entries: [] })
    await smsFor({ env: { ...env, SMS_KAVENEGAR_TEMPLATE: '' } })
      .send({ to: '+989123456789', code: '123456', text: 'your code is 123456' })
    expect(calls[0].url).toContain('/sms/send.json')
    expect(Object.fromEntries(new URLSearchParams(calls[0].init.body)).message).toBe('your code is 123456')
  })

  it('treats a refusal inside a 200 as a refusal', async () => {
    // The trap this provider sets: an invalid key and an unapproved pattern are both HTTP 200.
    stubFetch({ return: { status: 411, message: 'invalid receptor' } })
    await expect(smsFor({ env }).send({ to: '+989123456789', code: '1' }))
      .rejects.toThrow(/kavenegar refused: 411/)
  })
})

describe('sms.ir', () => {
  const env = { SMS_TRANSPORT: 'smsir', SMS_SMSIR_KEY: 'k-2', SMS_SMSIR_TEMPLATE_ID: '900' }

  it('sends the code through the registered pattern', async () => {
    const calls = stubFetch({ status: 1, data: { messageId: 5 } })
    const r = await smsFor({ env }).send({ to: '+989123456789', code: '123456' })

    expect(calls[0].url).toContain('/v1/send/verify')
    expect(calls[0].init.headers['X-API-KEY']).toBe('k-2')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      mobile: '09123456789', templateId: 900, parameters: [{ name: 'CODE', value: '123456' }]
    })
    expect(r).toMatchObject({ accepted: true, transport: 'smsir', id: 5 })
  })

  it('uses the parameter name the pattern was registered with', async () => {
    const calls = stubFetch({ status: 1, data: {} })
    await smsFor({ env: { ...env, SMS_SMSIR_PARAM: 'Code' } }).send({ to: '+989123456789', code: '9' })
    expect(JSON.parse(calls[0].init.body).parameters[0].name).toBe('Code')
  })

  it('says what is missing rather than calling an endpoint it cannot use', async () => {
    stubFetch({ status: 1 })
    await expect(smsFor({ env: { SMS_TRANSPORT: 'smsir', SMS_SMSIR_KEY: 'k' } })
      .send({ to: '+989123456789', code: '1', text: 'x' })).rejects.toThrow(/SMS_SMSIR_TEMPLATE_ID/)
  })

  it('treats status 0 as a refusal', async () => {
    stubFetch({ status: 0, message: 'اعتبار کافی نیست' })
    await expect(smsFor({ env }).send({ to: '+989123456789', code: '1' }))
      .rejects.toThrow(/sms\.ir refused: 0/)
  })
})

describe('the message', () => {
  it('is Persian when nobody says otherwise', () => {
    // The one server-composed string in this repo that does not fall back to English.
    expect(codeMessage({ code: '123456' })).toMatch(/کد ورود/)
    /* The minutes read as Persian prose; the code does not, because a code in Persian digits
     * is one neither iOS nor Android offers to autofill out of the message. */
    expect(codeMessage({ code: '123456' })).toContain('۵ دقیقه')
    expect(codeMessage({ code: '123456' })).toContain('123456')
    expect(codeMessage({ code: '123456', locale: 'ru' })).toMatch(/کد ورود/)
  })

  it('carries the code, the brand and the expiry, and nothing else', () => {
    const text = codeMessage({ code: '123456', locale: 'en', brand: 'GymYar' })
    expect(text).toContain('123456')
    expect(text).toContain('GymYar')
    expect(text).toContain('5 minutes')
    expect(text).not.toMatch(/https?:\/\//)   // never a link in an OTP message
  })

  it('names the instance the operator registered', () => {
    expect(smsBrand({ SMS_BRAND: 'ژیم‌یار' })).toBe('ژیم‌یار')
    expect(smsBrand({ RP_NAME: 'Studio' })).toBe('Studio')
    expect(smsBrand({})).toBe('GymYar')
  })
})
