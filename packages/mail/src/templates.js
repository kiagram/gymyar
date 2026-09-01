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

/* The second message this app sends, and the last one planned: a code confirming that whoever
 * typed an address can read it.
 *
 * A code rather than a link, which is the opposite of the reset above it and deliberate. A
 * reset is opened by somebody who is *not* signed in, often on a different device, so a link is
 * the only thing that can carry them into the right screen. This one is read by somebody who is
 * already signed in and looking at the field they typed the address into — sending them out to
 * a browser tab to come back to where they started is worse than six digits, and it is the same
 * six digits the SMS channel already asks for, on the same screen.
 *
 * Six minutes of a person's attention is the whole design constraint, so: the code, what it is
 * for, and how long it lasts. No link, because a link in a verification mail is a habit worth
 * not teaching. */
const CODE = {
  en: {
    subject: 'Your GymYar code',
    body: (name, code, minutes) => `Hi ${name},

${code} is your GymYar confirmation code. It expires in ${minutes} minutes.

You are seeing this because somebody added this address to a GymYar account. If that wasn't you, ignore this email — nothing has been added and the address is not on any account.`
  },

  fa: {
    subject: 'کد تأیید جیم‌یار',
    body: (name, code, minutes) => `سلام ${name}،

کد تأیید جیم‌یار شما: ${code}
تا ${faDigits(minutes)} دقیقه معتبر است.

این ایمیل را دریافت کرده‌اید چون کسی این نشانی را به یک حساب جیم‌یار افزوده است. اگر شما نبوده‌اید، نادیده‌اش بگیرید — چیزی افزوده نشده و این نشانی روی هیچ حسابی نیست.`
  }
}

/* Persian digits for the minutes and Latin for the code, for the reason spelled out in
 * packages/sms/src/templates.js — `۵ دقیقه` is how a number reads in Persian prose, and a code
 * in Persian digits is one no mail client or keyboard offers to copy usefully. */
const faDigits = n => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d])

/** How long a confirmation code lives. Stated in the text — see packages/db/src/codes.js. */
export const CODE_TTL_MINUTES = 5

/**
 * The confirmation email, in this account's language.
 *
 * English for a language with no translation here, like the reset above — this one is sent to
 * somebody who already has an account, so `user.locale` is a real answer rather than a guess.
 */
export function codeEmail({ name, code, locale = 'en', minutes = CODE_TTL_MINUTES }) {
  const pack = CODE[locale] || CODE.en
  return { subject: pack.subject, text: pack.body(name || 'there', code, minutes) }
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
