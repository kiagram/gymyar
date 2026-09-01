/* SMS.ir.
 *
 * The same shape as Kavenegar next door and the same reasoning — a registered pattern on the
 * transactional route, because that is the only route a one-time code reliably travels in Iran.
 * The differences are mechanical: a header for the key rather than a path segment, JSON rather
 * than a form, a numeric template id rather than a name, and named parameters rather than one
 * `token`.
 *
 * The parameter name is configurable because it is chosen when the pattern is registered, in
 * somebody else's dashboard, and a hardcoded `CODE` is a support ticket for every instance that
 * called theirs something else.
 */
import { national, postJSON, SmsError } from './http.js'

const BASE = 'https://api.sms.ir/v1'

export function smsirTransport(env) {
  const key = env.SMS_SMSIR_KEY
  if (!key) throw new Error('SMS_TRANSPORT=smsir needs SMS_SMSIR_KEY')
  const templateId = env.SMS_SMSIR_TEMPLATE_ID ? Number(env.SMS_SMSIR_TEMPLATE_ID) : null
  const param = env.SMS_SMSIR_PARAM || 'CODE'
  const line = env.SMS_SMSIR_LINE || null

  return {
    name: 'smsir',
    async send({ to, code, text }) {
      const mobile = national(to)
      const headers = { 'X-API-KEY': key, Accept: 'application/json' }

      const res = templateId
        ? await postJSON(`${BASE}/send/verify`, {
            mobile, templateId, parameters: [{ name: param, value: String(code) }]
          }, headers)
        : await postJSON(`${BASE}/send/bulk`, {
            // Bulk needs a line number — there is no default sender on this account type — so
            // without one there is nothing to fall back *to*, and saying so beats a 400 from
            // an endpoint the operator never meant to use.
            lineNumber: line ?? (() => {
              throw new Error('SMS_TRANSPORT=smsir needs SMS_SMSIR_TEMPLATE_ID (or SMS_SMSIR_LINE to send unregistered messages)')
            })(),
            messageText: text, mobiles: [mobile]
          }, headers)

      // Same envelope trap as Kavenegar: the transport-level answer is 200 and the real one is
      // in `status`, where 1 is success and everything else is a reason nobody got a message.
      if (res?.status !== 1) {
        throw new SmsError(`sms.ir refused: ${res?.status} ${res?.message || ''}`.trim(), {
          provider: 'smsir', providerStatus: res?.status
        })
      }
      return { accepted: true, transport: 'smsir', id: res?.data?.messageId ?? null }
    }
  }
}
