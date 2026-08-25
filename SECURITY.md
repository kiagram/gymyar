# Security policy

GymBuddy is a self-hosted app: you run the server, you hold the data. This file says which
versions get fixes, how to report something privately, and — the part most people actually
need — what the app protects you from and what it doesn't.

If you host GymBuddy for other people, read the [security model](#security-model) before you
invite anybody. Coaching means one account can read another's training, and that is a bigger
promise than a single-user tracker ever makes.

## Supported versions

Only the **latest release**. Releases are semver tags (see [CHANGELOG.md](CHANGELOG.md));
there is no LTS or maintenance branch, and older tags are never patched.

Updating a self-hosted instance:

```bash
git pull && docker compose up -d --build
```

## Reporting a vulnerability

> **This section is not usable yet.** GymBuddy has no public repository, so there is no private
> reporting channel to point you at — see [docs/PUBLISHING.md](docs/PUBLISHING.md). Until there
> is one, contact the maintainer directly. **Do not open a public issue containing a working
> exploit against other people's instances.**
>
> When the repository is published, this section should name its private vulnerability
> reporting link and nothing else.

Useful in a report: the version or commit, whether you are running a source build or your own
images, your `RP_ID` / `ORIGIN` and what sits in front of the app, steps to reproduce, and what
an attacker gets out of it.

**On response times:** there is no SLA and no bounty. If a report goes unfixed and you want to
disclose publicly, say so — there is no objection and no request to sit on it indefinitely.

## In scope

- **Authentication and sessions** — forging or replaying a session cookie, bypassing passkey
  verification, defeating the password path, or reaching `/api/admin/*` without `is_admin`.
- **Cross-account reads and writes.** This is the important one. Anything that lets an account
  read another account's training, or write to it, outside the coaching rules below: a coach
  reading a scope their client did not grant, a coach writing a client's rows at all, a client
  reading another client of the same coach, or any route that accepts a user id from the caller.
- **Delta sync** — receiving rows belonging to another user, or writing rows attributed to one.
- **Billing** — obtaining or extending an entitlement without a verified payment, having a
  payment credited twice, or altering the amount that gets verified against the gateway.
- **The AI layer** — anything that makes a model's output reach the database without a person
  confirming it, or that gets one user's training into another user's prompt.
- **Frontend** — XSS in the React app, or anything letting another origin read or change a
  signed-in user's data.
- **Shipped deployment config** — `docker-compose.yml`, `infra/web/nginx.conf`, the Dockerfiles:
  a default that exposes something a self-hoster would not expect to be exposed.
- **The native builds** reaching the network at all. They declare to app stores that they
  transmit nothing; `infra/scripts/check-mobile-hosts.mjs` enforces it, and a bypass is a bug.

## Out of scope

- Anything that already assumes access to the host, the Postgres volume, or the Docker socket.
  The operator is trusted by design — see the security model.
- Admins reading their users' data. That is the documented purpose of the admin dashboard.
- A **coach** reading a client's data within a scope that client granted. That is the product.
- **Missing security headers** (CSP, HSTS, X-Frame-Options) — nginx sets none; TLS and headers
  are the reverse proxy's job. A concrete attack that headers would have stopped is still worth
  reporting.
- Instances served over plain `http://` on a LAN IP. Unsupported: passkeys do not work there
  and the session cookie is not marked `Secure`.
- Scanner output with no working exploit, and `npm audit` findings in build-time
  devDependencies (Vite, Vitest, Capacitor CLI) that never reach a running instance.
- Third-party content: the exercise image and animation dataset, and the CDN it is fetched from.

## Security model

### What it does

- **Two ways in, both verified server-side.** Passkeys go through `@simplewebauthn/server`
  against `expectedOrigin: ORIGIN` and `expectedRPID: RP_ID`, with the authenticator's signature
  counter stored and updated on every login. Passwords are hashed with **scrypt**
  (N=16384, r=8, p=1, 64-byte key, per-user random salt) and compared in constant time, with a
  length check first so a mismatched length is not a faster "no"
  ([`packages/db/src/users.js`](packages/db/src/users.js)). Minimum length is 10 characters.
- **Sessions are a signed cookie.** `gymsid` carries `<uid>:<expiry>:<version>` plus an
  HMAC-SHA256 tag over it, compared with `timingSafeEqual`
  ([`apps/api/src/session.js`](apps/api/src/session.js)). `HttpOnly`, `SameSite=Lax`, and
  `Secure` **only when `ORIGIN` starts with `https:`**.
- **Any user can end every session they have.** `POST /api/logout/all` bumps that account's
  `session_version`; every authenticated request compares the cookie's version against the
  user record, so every cookie ever issued for the account stops verifying at once — on every
  device, including one somebody walked off with. Passkeys and passwords are untouched.
- **A coach never writes a client's rows.** A coach-authored programme lands in
  `routine_revisions` and becomes real only when the client accepts it, at which point it is
  written as the client's own row through the normal sync path. This is structural, not a
  permission check: there is only ever one writer per row.
- **Every coach-side read is gated on a granted scope.** `requireScope()` throws 403 unless the
  client's link carries it ([`packages/db/src/coaching.js`](packages/db/src/coaching.js)).
  Scopes are `programmes`, `workouts` and `bodyweight`, chosen by the **client** on accepting —
  an invitation that asked for bodyweight does not get it because the client clicked through
  quickly — and changeable afterwards.
- **Rate limiting is on by default**, keyed by **account** rather than by address. Users behind
  carrier-grade NAT share an address, so an IP-keyed limit lets one abuser lock out a
  neighbourhood. Sign-in is keyed by the identifier being tried, so failing to guess one
  person's password cannot lock anyone else out. Model-backed routes get tight buckets because
  they cost real money; sync is deliberately not throttled, because dropping a push loses
  training. Buckets are in one file:
  [`apps/api/src/rate-limit.js`](apps/api/src/rate-limit.js).
- **A payment cannot be credited twice.** A unique index on `(gateway, ref_id)` is the guard,
  and `credit()` writes first and treats the violation as the success it is — a read-then-check
  loses that race, an index cannot. Verification always sends the **stored** amount, so a
  tampered callback is a rejection from the gateway rather than a cheap year.
- **Nothing the model produces is applied on its own.** A generated programme returns for a
  person to look at; a drafted change fills a composer. There is no endpoint that writes
  training from a model's output.
- **Disabling an account takes effect immediately** — every authenticated request and every
  login is rejected for a disabled user.

### What it does not do

- **Nothing in the database is encrypted at rest.** Postgres holds every account, every set
  ever logged, passkey public keys, password hashes and body-weight history. Anyone who can
  read that volume — you, whoever holds the backups, whoever gets into the host — can read
  every user's data, and with `SESSION_SECRET` can mint a valid session cookie for any account.
  **If you host GymBuddy for other people, they are trusting you exactly as much as they would
  trust any server operator.**
- **Admins can read everything.** A user flagged `is_admin` gets every user's data and can
  disable accounts and manage invite codes. Off by default — a fresh instance has no admin.
- **Sessions cannot be revoked one device at a time.** Revocation is per *account*:
  `POST /api/logout/all` kills all of them and there is no device list. `POST /api/logout`
  clears the cookie in that one browser only — a copy taken beforehand keeps working. Sessions
  last `SESSION_DAYS` days, and each cookie carries the lifetime it was issued with, so changing
  the setting does not reach cookies already out.
- **CSRF protection is `SameSite=Lax` and nothing else.** There are no CSRF tokens.
- **User verification is preferred, not required** on both passkey handshakes, so a passkey
  released without a biometric or PIN is still accepted. In practice: unlocked device ≈ account
  access.
- **There is no password reset and no email verification.** No mail is sent at any point. An
  address is an identifier, not a verified channel — so it cannot be used to recover an account,
  and losing the credential means losing the profile.
- **`POST /api/register/password` is not on the `auth` rate-limit bucket.** Every other
  authentication route is; this one falls through to the default ceiling (240/minute). It
  answers 409 for an address that already exists, so at that rate it is also an email-enumeration
  oracle. Registration on an open instance should have a limit in front of it, or
  `INVITE_ONLY=1` set.
- **Disabling someone is not a ban.** They can register a fresh profile unless `INVITE_ONLY=1`.
- **HTTPS is required and the app does not provide it.** The API speaks plain HTTP and nginx
  listens on `:80`; TLS is your reverse proxy's job. Without it browsers will not do passkeys at
  all (except on `http://localhost`) and the session cookie is sent in the clear.
- **Some endpoints answer without a session:** `/api/health` — which includes the **total user
  count** and is exempt from rate limiting — `/api/config` (whether invite-only is on),
  `/api/push/public-key`, the register and login handshakes, and the payment callback.
- **Changing `RP_ID` invalidates every existing passkey.** They were bound to the old hostname
  and will fail verification against the new one. The data stays in the database but is
  unreachable by passkey until each user registers again. Choose your hostname before anyone
  signs up. Accounts with a password set can still get in.
- **A coach keeps what they already read.** Withdrawing a scope stops future reads; it does not
  reach into notes, messages or anything the coach exported while it was granted. Scopes are an
  access control, not a recall.
- **Model providers see what you send them.** With a provider configured, briefs and the
  training summaries behind a written note leave your server. Configure none, or point it at a
  model on your own hardware, and nothing does — the deterministic path produces the same plans
  and findings either way, and `/api/ai/status` says which is in force.
- **The native builds hold training unencrypted** in a file in the app's private storage. That
  is device security, not ours: anyone with the unlocked phone, or a backup of it, has the log.

## Inherited code

GymBuddy is a derivative of [openGym](https://gitea.com/DuarteSantos/openGym); the session
scheme and the passkey handshakes carry across from it in substance. A vulnerability in that
shared lineage likely affects both projects — please say so in your report, so upstream can be
told. See [NOTICE.md](NOTICE.md).

**If you deployed anything built from the `arvids-unavailable/openGym` GitHub re-upload**,
rotate your secrets now: that tree had a live instance's session signing secret, VAPID private
key and user records committed to it. GymBuddy does not carry them — `data/` and `media/` were
dropped at the fork and are gitignored — but anything derived from the re-upload is signing
cookies with a public key.
