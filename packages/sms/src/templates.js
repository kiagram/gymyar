/* The one thing this app texts somebody: a code, and how long it is good for.
 *
 * ## Why there is barely anything here
 *
 * On a real Iranian gateway this text is not sent by us. Kavenegar and SMS.ir both deliver
 * one-time codes through a *pattern* — a message body registered with the operator in advance,
 * with a slot for the code — and the API call carries the code and the pattern's name, not
 * prose. That is not a quirk of their APIs: an unregistered bulk message to an Iranian handset
 * is filtered, delayed or dropped, and a signup flow whose SMS arrives eleven minutes later is
 * a signup flow that does not work. So the wording below is what the *operator* approved, and
 * this file is what renders it when nobody else will.
 *
 * Which is two cases, both real: `SMS_TRANSPORT=log` on a household instance, where this text
 * is what the operator reads out of the log; and a gateway configured with no pattern id, where
 * the provider is asked to send a plain message and this is its body.
 *
 * ## Persian by default, and that is the right way round here
 *
 * Every other server-composed string in this repo takes the locale of the account it is about
 * — see packages/mail/src/templates.js. This one cannot: it is sent *before* there is an
 * account, to a number that has told us nothing except that it is Iranian. The signup screen
 * passes the language it is being read in, and the fallback when it says nothing is Persian,
 * because a +98 handset is the whole reason this code path exists.
 *
 * ## No link, no name, no brand ornament
 *
 * A URL in an OTP message is a phishing lesson taught by the product itself, and the more a
 * code message looks like marketing the more likely a carrier is to treat it as marketing. Name,
 * number, minutes, and the one sentence that tells somebody who did not ask for it what to do.
 */

/** How long a code lives, in minutes. Stated in the text — see the note in codes.js. */
export const CODE_TTL_MINUTES = 5

const faDigits = n => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d])

const T = {
  en: ({ code, minutes, brand }) =>
    `${code} is your ${brand} code. It expires in ${minutes} minutes. If you didn't ask for it, ignore this message.`,

  /* The minutes are written in Persian digits and the code is not, which is the one line in
   * this file worth an explanation. `۵ دقیقه` is how a number reads inside Persian prose. The
   * code stays Latin because it is not prose: it is six characters somebody reads off a lock
   * screen and types into a field, iOS and Android autofill it out of the message body by
   * matching digits, and a code written `۸۵۵۰۳۷` is one neither of them offers to fill in. */
  fa: ({ code, minutes, brand }) =>
    `کد ورود ${brand} شما: ${code}\nتا ${faDigits(minutes)} دقیقه معتبر است. اگر شما درخواست نداده‌اید، این پیام را نادیده بگیرید.`
}

export const SMS_LOCALES = Object.keys(T)

/**
 * The body of a code message.
 *
 * Persian for anything with no translation here, for the reason in the header — this is the
 * one server-composed string in the repo whose fallback is not English.
 */
export function codeMessage({ code, locale = 'fa', brand = 'GymYar', minutes = CODE_TTL_MINUTES }) {
  return (T[locale] || T.fa)({ code, minutes, brand })
}
