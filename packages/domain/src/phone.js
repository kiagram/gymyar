/* Iranian mobile numbers: reading what somebody typed, and writing it back one way.
 *
 * This is in the domain rather than in the API because both sides need the same answer. The
 * client formats and pre-checks a number so the field can say "that is not a mobile number"
 * before a request is spent; the server normalises the number it stores and the number it
 * looks up, and those two must agree exactly or an account becomes unreachable by the phone
 * that created it. One function, imported twice, is the only way that stays true.
 *
 * ## What is canonical
 *
 * `+989xxxxxxxxx` — E.164, no spaces, no separators, Latin digits. It is what goes in the
 * column, what the unique index is built on, what the SMS provider is handed and what the OTP
 * is keyed by. Everything a person types is a spelling of it.
 *
 * ## What people actually type
 *
 * All of these are the same number, and every one of them turns up in a real signup field:
 *
 *     09123456789          the way it is written on every business card in Iran
 *     ۰۹۱۲۳۴۵۶۷۸۹          the same, from a Persian keyboard — the default on an Iranian phone
 *     ٠٩١٢٣٤٥٦٧٨٩          Arabic-Indic digits, which some keyboards produce instead
 *     +98 912 345 6789     pasted from a contact card
 *     0098-912-345-6789    the old international spelling, still on printed material
 *     989123456789         copied out of a provider's dashboard
 *     9123456789           what is left after somebody deletes the leading zero
 *
 * The Persian and Arabic-Indic digits are the ones worth being loud about. `۰۹۱۲…` is what an
 * Iranian phone produces with no effort from its owner, it is visually identical to the Latin
 * form in most fonts, and `parseInt` gives up on it silently. A signup form that rejects it is
 * a form that tells the majority of this product's market that their own phone number is not a
 * phone number.
 *
 * ## Mobile only, and why the rule is loose
 *
 * A landline cannot receive an SMS, so a number that is not a mobile is not an account. Iranian
 * mobile numbers are `09` followed by eight more digits, which is `9` + nine digits nationally.
 * The check stops there rather than listing operator prefixes: 0910–0919 is Hamrah-e Aval,
 * 0930/0933/0935/0936/0937/0938/0939/0901–0905 is Irancell, 0920–0922 is Rightel, and that list
 * has grown every few years since it was first written down. An allowlist would reject a real
 * number the day a new range is allocated, and the SMS simply not arriving is a better failure
 * than a signup form that refuses to believe somebody.
 */

/* Persian (U+06F0) and Arabic-Indic (U+0660) digits, mapped to the Latin ones. Also the two
 * invisible characters a Persian keyboard sprinkles into anything — ZWNJ and RLM — which are
 * not separators but are not digits either, and which make an otherwise identical string
 * compare unequal. */
const DIGITS = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9'
}

/**
 * Latin digits and nothing else, from whatever was typed.
 *
 * Exported because the OTP field needs it too — a six-digit code typed on the same keyboard
 * arrives as `۱۲۳۴۵۶`, and a comparison against `123456` fails for a person who entered the
 * right code. Same fix, same reason, one implementation.
 */
export const latinDigits = s =>
  String(s ?? '').replace(/[۰-۹٠-٩]/g, d => DIGITS[d] ?? d)

/**
 * The canonical `+989xxxxxxxxx`, or null if that is not what this is.
 *
 * Null rather than a throw: the caller is a form field on a keystroke as often as it is a
 * request handler, and "not yet a number" is the ordinary state of a field somebody is halfway
 * through typing into.
 */
export function normalizePhone(input) {
  // Everything that is not a digit goes, after the digits have been made Latin. Separators are
  // decoration — spaces, dashes, brackets, dots, and the invisible marks noted above — and the
  // leading `+` is carried by the country code that follows it rather than by itself.
  const digits = latinDigits(input).replace(/\D+/g, '')
  if (!digits) return null

  // The four spellings of the same ten national digits. Ordered longest prefix first, so
  // `00989…` is not read as `0` + `0989…`.
  const national =
    digits.startsWith('0098') ? digits.slice(4)
    : digits.startsWith('98') && digits.length === 12 ? digits.slice(2)
    : digits.startsWith('0') ? digits.slice(1)
    : digits

  // Ten digits starting with 9 — see the header for why the rule stops there.
  return /^9\d{9}$/.test(national) ? '+98' + national : null
}

/** Whether this would be accepted. The form's check, and the server's guard. */
export const isIranianMobile = input => normalizePhone(input) !== null

/**
 * The way an Iranian reads their own number back: `0912 345 6789`.
 *
 * Not E.164. `+98` is how a network is addressed, not how anybody in Tehran says a number, and
 * a confirmation screen that shows a person a spelling they do not recognise is a screen they
 * hesitate at. Anything unparseable comes back untouched rather than mangled.
 */
export function formatPhone(input) {
  const e164 = normalizePhone(input)
  if (!e164) return String(input ?? '')
  const n = e164.slice(3)                       // 9xxxxxxxxx
  return `0${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`
}

/**
 * Enough of a number to recognise, not enough to dial: `0912•••6789`.
 *
 * For the one sentence that has to name a number without publishing it — "a code is on its way
 * to …", which is shown after a code is requested and therefore before anybody has proved the
 * number is theirs. Somebody who mistyped a digit needs to see that; somebody watching over
 * their shoulder does not need the whole thing.
 */
export function maskPhone(input) {
  const e164 = normalizePhone(input)
  if (!e164) return ''
  const n = e164.slice(3)
  return `0${n.slice(0, 3)}•••${n.slice(-4)}`
}
