/* The one email this app sends, in the languages it speaks.
 *
 * ## Why these are here and not in the locale packs
 *
 * Every other string in GymYar is translated in the client, because every other string is
 * rendered there. This one is written by the server for somebody who is not signed in, on a
 * device that may not be the one they use the app on. There is nobody to ask.
 *
 * That is only possible because `users.locale` is real now — it shipped as a column nothing
 * ever wrote, which would have made this English for everybody regardless of what is below.
 * The language used is the account's own setting, not the browser that asked: the person
 * reading this is the account holder, and what they set on their profile is the better answer
 * than whatever locale the machine requesting the reset happens to have.
 *
 * ## Why an hour is not configurable
 *
 * The text says an hour, in both languages. A knob that changes the expiry without changing
 * the sentence is a knob that makes the email lie, and translating "{0} hours" correctly across
 * languages with four plural forms to save an operator a setting nobody has asked for is not a
 * trade worth making. One hour, stated, everywhere.
 */

/** How long a reset link lives. Stated in the text below — see the header before changing it. */
export const RESET_TTL_MINUTES = 60

const T = {
  en: {
    subject: 'Reset your GymYar password',
    body: (name, url) => `Hi ${name},

Someone asked to reset the password on your GymYar account. If that was you, open this link:

${url}

The link works once, and stops working after an hour.

If it wasn't you, ignore this email — nothing has changed and your current password still works.`
  },

  fa: {
    subject: 'بازنشانی رمز عبور جیم‌یار',
    body: (name, url) => `سلام ${name}،

کسی درخواست بازنشانی رمز عبور حساب جیم‌یار شما را داده است. اگر خودتان بوده‌اید، این پیوند را باز کنید:

${url}

این پیوند یک‌بار کار می‌کند و پس از یک ساعت از کار می‌افتد.

اگر شما نبوده‌اید، این ایمیل را نادیده بگیرید — چیزی تغییر نکرده و رمز عبور فعلی‌تان همچنان کار می‌کند.`
  }
}

export const MAIL_LOCALES = Object.keys(T)

/**
 * The reset email, in this account's language.
 *
 * English for a language with no translation here rather than a throw: an email that goes out
 * in the wrong language is a bad day, and one that does not go out at all is a lost account.
 */
export function resetEmail({ name, url, locale = 'en' }) {
  const pack = T[locale] || T.en
  return { subject: pack.subject, text: pack.body(name || 'there', url) }
}
