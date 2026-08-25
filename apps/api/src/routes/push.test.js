/* The wording of a push notification.
 *
 * A notification is the only string the server sends that nobody can correct afterwards — it
 * arrives on a lock screen, in whatever language it was written in, and there is no language
 * on a user row or a subscription for the server to consult. So the client sends the text and
 * this decides what to trust. The failure it exists to prevent is quiet: an app running
 * entirely in Persian that buzzes "Rest over".
 *
 * No database here — the helper is pure, which is why it is a helper.
 */
import { describe, it, expect } from 'vitest'
import { notificationText } from './push.js'

describe('what a notification ends up saying', () => {
  it('uses what the client sent', () => {
    expect(notificationText('استراحت تمام', 'Rest over')).toBe('استراحت تمام')
  })

  it('falls back to English when the client sent nothing', () => {
    // An older build, or a request that lost the field. Both look identical from here.
    expect(notificationText(undefined, 'Rest over')).toBe('Rest over')
    expect(notificationText(null, 'Next set.')).toBe('Next set.')
    expect(notificationText('', 'Next set.')).toBe('Next set.')
    expect(notificationText('   ', 'Next set.')).toBe('Next set.')
  })

  it('falls back rather than rendering whatever a non-string stringifies to', () => {
    for (const junk of [42, true, {}, [], { toString: () => 'nope' }]) {
      expect(notificationText(junk, 'Rest over')).toBe('Rest over')
    }
  })

  it('trims, because a lock screen shows the leading space', () => {
    expect(notificationText('  Rest over  ', 'x')).toBe('Rest over')
  })

  it('caps the length — it arrives in a request body', () => {
    const long = 'ب'.repeat(500)
    expect(notificationText(long, 'Rest over')).toHaveLength(120)
  })
})
