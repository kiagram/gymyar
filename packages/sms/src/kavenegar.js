/* Kavenegar.
 *
 * Two endpoints, and which one is used is the whole design decision in this file.
 *
 *   verify/lookup   a *pattern* — a body registered with the operator in advance, with slots.
 *                   Delivered on the transactional route: it reaches a handset in seconds, it
 *                   is not subject to the recipient's bulk-SMS opt-out, and it arrives at three
 *                   in the morning if that is when somebody signed up.
 *   sms/send        a message body we compose. Bulk. Filtered, deprioritised, and refused
 *                   outright for anything that looks like a code on some operators.
 *
 * A one-time code belongs on the first. `SMS_KAVENEGAR_TEMPLATE` is therefore not optional in
 * practice, and the fallback to `sms/send` exists so that an instance mid-setup — a key issued,
 * the pattern still awaiting approval, which takes days — can see the whole flow work end to
 * end rather than being blocked on somebody else's queue. It is documented as the temporary
 * state it is.
 *
 * ## The receptor is the national form
 *
 * `09123456789`, not `+989123456789`. Kavenegar's `receptor` is an Iranian subscriber number
 * and the international spelling is rejected by it — so the conversion happens here, at the
 * edge that cares, and everything upstream of this file stays E.164. Same for SMS.ir.
 */
import { national, postForm, SmsError } from './http.js'

const BASE = 'https://api.kavenegar.com/v1'

export function kavenegarTransport(env) {
  const key = env.SMS_KAVENEGAR_KEY
  if (!key) throw new Error('SMS_TRANSPORT=kavenegar needs SMS_KAVENEGAR_KEY')
  const template = env.SMS_KAVENEGAR_TEMPLATE || null
  const sender = env.SMS_KAVENEGAR_SENDER || null

  return {
    name: 'kavenegar',
    /* `code` is what the pattern's slot is filled with; `text` is the whole body, used only on
     * the fallback path. Callers pass both and let the transport decide, rather than the caller
     * having to know which provider it is talking to. */
    async send({ to, code, text }) {
      const receptor = national(to)
      const url = template
        ? `${BASE}/${encodeURIComponent(key)}/verify/lookup.json`
        : `${BASE}/${encodeURIComponent(key)}/sms/send.json`
      const body = template
        ? { receptor, token: code, template }
        : { receptor, message: text, ...(sender ? { sender } : {}) }

      const res = await postForm(url, body)
      /* Kavenegar answers 200 with the real outcome in the envelope — an invalid key, an
       * unapproved pattern and a blocked number are all HTTP 200 with a `return.status` that
       * is not. Reading only the HTTP status here would report every one of those as a code
       * successfully sent, and the person waiting for it would never be told anything. */
      const status = res?.return?.status
      if (status !== 200) {
        throw new SmsError(`kavenegar refused: ${status} ${res?.return?.message || ''}`.trim(), {
          provider: 'kavenegar', providerStatus: status
        })
      }
      return { accepted: true, transport: 'kavenegar', id: res?.entries?.[0]?.messageid ?? null }
    }
  }
}
