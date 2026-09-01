/* The mail seam: which transport a deployment gets, and what the one email says.
 *
 * No SMTP server is stood up here. What is worth testing is the configuration — an instance
 * that thinks it can send mail and cannot is the failure this package exists to make loud —
 * and the templates, which are the only user-facing English (and Persian, and ten others) that
 * no locale check can see.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mailerFor, mailEnabled, resetEmail, codeEmail, MAIL_LOCALES } from './index.js'

const env = (over = {}) => ({ MAIL_FROM: 'GymYar <no-reply@example.test>', ...over })

afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith('MAIL_')) delete process.env[k]
})

describe('which transport a deployment gets', () => {
  it('is none at all by default', () => {
    expect(mailerFor({ env: env() })).toBe(null)
    expect(mailEnabled(env())).toBe(false)
  })

  it('treats an explicit off as off', () => {
    expect(mailerFor({ env: env({ MAIL_TRANSPORT: 'off' }) })).toBe(null)
    expect(mailEnabled(env({ MAIL_TRANSPORT: 'off' }))).toBe(false)
    expect(mailEnabled(env({ MAIL_TRANSPORT: 'OFF' }))).toBe(false)
  })

  it('builds an SMTP transport when it has what it needs', () => {
    const m = mailerFor({ env: env({ MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: 'mail.example.test' }) })
    expect(m.name).toBe('smtp')
    expect(mailEnabled(env({ MAIL_TRANSPORT: 'smtp' }))).toBe(true)
  })

  it('refuses to be half-configured, at boot rather than at the first reset', () => {
    // A missing host or sender is not something to discover when somebody is locked out.
    expect(() => mailerFor({ env: env({ MAIL_TRANSPORT: 'smtp' }) }))
      .toThrow(/MAIL_SMTP_HOST/)
    expect(() => mailerFor({ env: { MAIL_TRANSPORT: 'smtp', MAIL_SMTP_HOST: 'h' } }))
      .toThrow(/MAIL_FROM/)
  })

  it('says what it does not understand, and what it does', () => {
    expect(() => mailerFor({ env: env({ MAIL_TRANSPORT: 'carrier-pigeon' }) }))
      .toThrow(/expected 'smtp', 'log', or unset/)
  })

  it('writes to the log when asked to, and says it did not send', async () => {
    const lines = []
    const log = { info: (fields, msg) => lines.push({ fields, msg }) }
    const m = mailerFor({ env: env({ MAIL_TRANSPORT: 'log' }), log })
    const r = await m.send({ to: 'sam@x.test', subject: 'Hi', text: 'a link' })

    expect(r).toEqual({ accepted: true, transport: 'log' })
    expect(lines).toHaveLength(1)
    expect(lines[0].msg).toMatch(/not sent/)
    // The body is the point: on this transport, the log line *is* the delivery.
    expect(lines[0].fields.body).toBe('a link')
    expect(lines[0].fields.to).toBe('sam@x.test')
  })

  it('does not need a logger to have been given one', async () => {
    const m = mailerFor({ env: env({ MAIL_TRANSPORT: 'log' }) })
    await expect(m.send({ to: 'x@y.test', subject: 's', text: 't' })).resolves.toBeTruthy()
  })
})

describe('the reset email', () => {
  const args = { name: 'Sam', url: 'https://gym.example/#/reset/abc123' }

  it('carries the link, which is the entire message', () => {
    for (const locale of MAIL_LOCALES) {
      const { subject, text } = resetEmail({ ...args, locale })
      expect(text).toContain(args.url)
      expect(subject.length).toBeGreaterThan(0)
    }
  })

  it('greets the person by name in every language', () => {
    for (const locale of MAIL_LOCALES) {
      expect(resetEmail({ ...args, locale }).text).toContain('Sam')
    }
  })

  it('is a whole message in every language, not a bare link', () => {
    /* Structural rather than a string match or a length: the words differ, and so does the
     * character count — Chinese says the same thing in a third of the characters English needs,
     * so a length threshold that fits both is a threshold that catches nothing. What every
     * translation must have is the four blocks around the URL: a greeting, the instruction, the
     * expiry, and the "wasn't you" line. A half-finished pack loses one of those. */
    for (const locale of MAIL_LOCALES) {
      const { text } = resetEmail({ ...args, locale })
      const blocks = text.replace(args.url, '').split(/\n\s*\n/).filter(b => b.trim())
      expect(blocks, locale).toHaveLength(4)
    }
  })

  it('is Persian when the account is', () => {
    const { subject, text } = resetEmail({ ...args, locale: 'fa' })
    expect(subject).toMatch(/[؀-ۿ]/)
    expect(text).toMatch(/[؀-ۿ]/)
    expect(text).not.toMatch(/Someone asked/)
  })

  it('falls back to English rather than failing to send', () => {
    // A language with no template is a bad day; an exception here is a lost account.
    expect(resetEmail({ ...args, locale: 'xx' }).text).toContain('Someone asked')
    expect(resetEmail({ ...args, locale: undefined }).text).toContain('Someone asked')
  })

  it('has a template for every language the app records', async () => {
    const { LOCALES } = await import('@gymyar/domain')
    // The server can store any of these on a profile, and this is the one place that turns one
    // into words. A language in the picker with no template here is an English email.
    expect([...MAIL_LOCALES].sort()).toEqual([...LOCALES].sort())
  })

  it('says an hour, because the code says an hour', async () => {
    const { RESET_TTL_MINUTES } = await import('./templates.js')
    const { RESET_TTL_MS } = await import('@gymyar/db/passwords.js')
    // The text is not parameterised — see the header in templates.js. This is what keeps the
    // sentence and the expiry from drifting apart silently.
    expect(RESET_TTL_MINUTES * 60 * 1000).toBe(RESET_TTL_MS)
  })
})

describe('the confirmation code email', () => {
  it('carries the code, what it is for, and no link at all', () => {
    const { subject, text } = codeEmail({ name: 'Ada', code: '123456' })
    expect(subject).toMatch(/code/i)
    expect(text).toContain('123456')
    expect(text).toContain('5 minutes')
    // A link in a verification mail is a habit worth not teaching.
    expect(text).not.toMatch(/https?:\/\//)
  })

  it('tells somebody who did not ask that nothing has happened', () => {
    // The address is not on the account until the code comes back, so this is true.
    expect(codeEmail({ name: 'Ada', code: '1' }).text).toMatch(/not on any account/)
  })

  it('is written in the account’s language, with Persian digits for the minutes', () => {
    const fa = codeEmail({ name: 'سام', code: '123456', locale: 'fa' })
    expect(fa.subject).toMatch(/کد تأیید/)
    expect(fa.text).toContain('۵ دقیقه')
    expect(fa.text).toContain('123456')      // the code stays Latin — see the template
  })

  it('falls back to English rather than not sending', () => {
    expect(codeEmail({ name: 'Ada', code: '1', locale: 'ru' }).subject)
      .toBe(codeEmail({ name: 'Ada', code: '1', locale: 'en' }).subject)
  })
})
