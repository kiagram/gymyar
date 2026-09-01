/* Who is allowed to ask for how much, and how often.
 *
 * The numbers all live here rather than beside the routes, for the same reason the coaching
 * permission rules live in one file: a limit you have to go looking for is a limit nobody
 * reviews. Routes opt into a bucket by name; this file decides what the name costs.
 *
 * ## Keyed by account, not by address
 *
 * The obvious key is the client's IP, and it is the wrong one for this product's users. Iranian
 * mobile and home connections sit behind carrier-grade NAT, so a single address can front an
 * entire neighbourhood. An IP-keyed limit there does not stop an abuser — it lets one abuser
 * lock out everybody who shares their carrier, and makes ordinary traffic look like an attack.
 *
 * So: signed-in requests are counted against the account, which is the thing actually spending
 * money. Only requests with no account fall back to the address, and the one place that really
 * matters — signing in — is keyed by the identifier being tried, so failing to guess one
 * person's password cannot lock their neighbours out of their own accounts.
 *
 * ## What is worth limiting
 *
 * Not everything. Sync is high-volume by design — a debounced push after every set — and
 * throttling it loses training data rather than saving anything. The expensive routes are the
 * ones that call a model, because each one costs real money and nothing else in this codebase
 * does. They get the tight buckets; everything else gets a ceiling that only a runaway client
 * or a script would ever reach.
 */
import rateLimit from '@fastify/rate-limit'
import { normalizePhone } from '@gymyar/domain'
import { config } from './config.js'
import { sessionUserId } from './session.js'

const MINUTE = 60_000

/**
 * The buckets. `max` requests per `window`, per key.
 *
 * `model` covers everything that can reach a language model. The numbers are deliberately far
 * above what a person drafting a plan does — a dozen attempts at describing your training is a
 * bad afternoon, not abuse — and far below what a loop costs.
 */
export const BUCKETS = {
  // Drafting a programme, and a coach drafting a change for a client. Both call a model and
  // both are things a person does a handful of times, thinks about, then does again.
  'model.draft': { max: 12, window: 10 * MINUTE },
  // Reading a typed log. Called mid-workout and more often, still model-backed.
  'model.parse': { max: 40, window: 10 * MINUTE },
  /* Looking at a form check. Tighter than either, because this one costs seconds of a GPU on
   * the deployment's own hardware rather than a few hundred tokens at somebody else's — a
   * handful of photographs is a person going through a session, and a hundred is a queue that
   * makes every other model call on the box slow. */
  'model.vision': { max: 8, window: 10 * MINUTE },
  // Signing in. Tight, and keyed by the identifier being tried rather than the address.
  'auth': { max: 10, window: 15 * MINUTE },
  /* Asking for a code by SMS. The tightest bucket here, and the only one whose cost is paid in
   * cash per request: every one of these is a message the operator is billed for and a buzz on
   * a handset that may not belong to whoever asked. Keyed by the number being texted, so it is
   * a ceiling on what one phone can be sent rather than on what one caller can ask.
   *
   * It is deliberately looser than the per-number cooldown and daily cap in
   * packages/db/src/phone-codes.js, which are the real limits. This one exists to stop the
   * requests before they reach a database transaction at all. */
  'sms': { max: 6, window: 15 * MINUTE },
  /* Asking for a reset link. Tighter than signing in and keyed the same way — by the address
   * being asked about — because the cost of this one is not a guess at a password, it is an
   * email somebody else receives. An unthrottled endpoint here is a way to use this instance to
   * send a stranger a hundred messages. */
  'password-reset': { max: 5, window: 60 * MINUTE },
  // Starting a checkout. Each one mints an authority at the gateway and a row here, and a
  // person buying a subscription does it once — twice if the first attempt went wrong.
  'billing': { max: 8, window: 10 * MINUTE },
  // Everything else: a ceiling, not a throttle.
  'default': { max: 240, window: MINUTE }
}

/** Route config for a bucket: `app.post('/x', { config: limit('model.draft') }, handler)`. */
export const limit = name => {
  const b = BUCKETS[name]
  if (!b) throw new Error(`unknown rate-limit bucket: ${name}`)
  return { rateLimit: { max: b.max, timeWindow: b.window } }
}

/* The identifier a sign-in attempt is about, so one account being guessed at does not spend
 * the budget of everyone else behind the same carrier. Falls back to the address when the
 * request does not name anybody — which is itself worth limiting. */
const authSubject = req => {
  const email = req.body?.email
  if (email) return 'email:' + String(email).trim().toLowerCase()
  /* A phone number, canonicalised before it becomes a key. `09123456789`, `+989123456789` and
   * `۰۹۱۲۳۴۵۶۷۸۹` are one number and must be one bucket — keyed raw, the same number spelled
   * three ways is three budgets, which is a limit that can be walked straight past by anybody
   * who notices. */
  const phone = req.body?.phone ? normalizePhone(req.body.phone) : null
  if (phone) return 'phone:' + phone
  return 'ip:' + req.ip
}

/* A reset that carries a token names no address, so there is nothing to key on but where it
 * came from. That is the weaker key — everyone behind one carrier address shares it — which is
 * why the budget for spending a token is generous where the budget for requesting one is not:
 * this endpoint cannot be used to send anybody anything. */

export async function registerRateLimit(app, { enabled = config.rateLimit } = {}) {
  if (!enabled) {
    app.log?.warn?.('rate limiting is off')
    return
  }

  await app.register(rateLimit, {
    global: true,
    max: BUCKETS.default.max,
    timeWindow: BUCKETS.default.window,
    // preHandler, not the default onRequest: the sign-in key is the account being tried, and
    // the body that names it has not been parsed yet at onRequest. Keyed too early, every
    // login in the country lands in one bucket — the exact failure this file exists to avoid.
    hook: 'preHandler',
    // Counted per account wherever there is one — see the note at the top of this file.
    keyGenerator: req => {
      if (req.routeOptions?.url?.startsWith('/api/login') ||
          req.routeOptions?.url?.startsWith('/api/register') ||
          req.routeOptions?.url?.startsWith('/api/phone') ||
          req.routeOptions?.url?.startsWith('/api/password')) {
        return authSubject(req)
      }
      const uid = sessionUserId(req)
      return uid ? 'user:' + uid : 'ip:' + req.ip
    },
    /* Health checks are how a container decides whether to keep running. Never throttle them.
     *
     * The public counters join them, and for a reason this file has already argued: they are
     * fetched by an anonymous visitor, so the only key available is the address — and a
     * landing page shared around one Iranian carrier would spend a single bucket on behalf of
     * a whole city. There is nothing to protect anyway. The response is six integers computed
     * at most once every five minutes and served from memory in between, so the hundredth
     * request in a second costs a property lookup, not a query. */
    allowList: req => req.url === '/api/health' || req.url.startsWith('/api/public/'),
    // The route handlers throw `{ status }` and a shared error handler turns that into a body;
    // this keeps a 429 the same shape as every other error the client already knows how to read.
    // What this returns is thrown as the error, so it has to carry the status itself —
    // without `statusCode` a correct 429 body goes out as a 500.
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429,
      error: `Too many requests — try again in ${Math.ceil(ctx.ttl / 1000)}s`,
      code: 'rate_limited',
      retryAfter: Math.ceil(ctx.ttl / 1000)
    })
  })
}
