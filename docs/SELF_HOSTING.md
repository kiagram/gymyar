# Self-hosting GymYar

Three containers and a Postgres volume: nginx serving the built app, the Fastify API, and the
database. This guide takes you from "just cloned it" to "using it from my phone over the
internet".

If you only want the offline single-user tracker, none of this applies — that build has no
backend at all. See [MOBILE.md](MOBILE.md).

## 1. Run it locally (5 minutes)

Requirements: [Docker](https://docs.docker.com/get-docker/) with the Compose plugin. No Node
needed — the images build the app for you.

```bash
git clone <your-repo> gymyar
cd gymyar
cp .env.example .env
docker compose up -d --build
```

- First start downloads the exercise images and GIFs (~140 MB) once into `./media/img` and
  `./media/gif`, then migrates the schema and seeds the 1,324-exercise library.
- With `SEED_DEMO=1` — the default in `.env.example` — it also creates a demo coach and three
  clients with twelve weeks of training each. The accounts are listed in the
  [README](../README.md).
- Open **http://localhost:8080** for the project site, and
  **http://localhost:8080/app/** to create a profile. Both are the same origin, which is what
  passkeys require — see section 2.

Check it's healthy:

```bash
docker compose ps
curl http://localhost:8080/api/health      # {"ok":true,"users":4}
```

Logs: `docker compose logs -f`. Stop: `docker compose down` — the database volume survives that;
`down -v` destroys it.

## 2. What is actually running

| Service | What it does | State |
|---|---|---|
| `web` | nginx: serves the project site at `/`, the built React app at `/app/` **and** proxies `/api` to the API, so everything is one origin — which WebAuthn requires. Also serves the exercise media. | none |
| `api` | Fastify on :3000, internal only. Migrates and seeds on every boot; both are idempotent, so every boot after the first is a no-op. | none |
| `db` | Postgres 16. **Every account and every set ever logged.** | `gymyar_db` volume |
| `media` | One-shot: clones the exercise dataset into `./media`, then exits. Skipped if the files are already there. | `./media` |

The exercise media is © [Gym visual](https://gymvisual.com/) and licensed separately from this
code — see [NOTICE.md](../NOTICE.md). Fine for a personal instance; a commercial deployment needs
its own licence or its own assets.

**Three things on one origin.** `/` is the project site (`apps/site` — hand-written HTML, no
build step), `/app/` is the application, `/api/` is the backend. Sharing an origin is not
tidiness: a passkey is bound to one, a session cookie is scoped to one, and the app fetching
`/api` with no CORS anywhere is a property of `infra/web/nginx.conf`. If you want the site and
the app on separate hostnames you will need a second certificate, a second deployment, and a
plan for the session that no longer crosses between them.

The site's front page reads `/api/public/stats` and shows what this instance has actually
done — accounts, sessions, sets, tonnage. Aggregates only, no account required, nothing that
narrows to a person. Set `PUBLIC_STATS=off` in `.env` and the endpoint stops existing; the
section then does not appear on the page at all.

If you are upgrading an instance that ran an earlier build, the app moved: it used to be at
`/`. Existing links keep working — `apps/site/site.js` forwards any `/#/route` to `/app/#/route`
— and `/sw.js` is now a tombstone that uninstalls the service worker the old build registered
at the root. Anyone who installed the PWA should reinstall it from `/app/`.

## 3. Sign-in, and why HTTPS matters

GymYar signs you in three ways: **passkeys** (WebAuthn), **email + password**, and a
**phone number** with a code by SMS. Passkeys are what the UI leads with; the password path
exists because "sign up" cannot be a dead end on a device whose browser will not do passkeys;
the phone path is section 9, needs a gateway, and is the one most of this product's users will
actually use.

Browsers enforce two rules on passkeys:

1. They are bound to an exact **hostname** (`RP_ID`).
2. They only work over **HTTPS** — with one exception: `http://localhost`.

So `http://localhost:8080` works on the machine running Docker, but **another device cannot use
`http://<your-LAN-ip>:8080`** — that is neither localhost nor HTTPS, so the passkey prompt never
appears. Email and password work over plain HTTP, but sending a password in clear text across
your network is not a plan, and the session cookie is only marked `Secure` when `ORIGIN` is
`https:`. To use GymYar from your phone, get a real HTTPS hostname.

(You can also open it over LAN in **guest mode**, which keeps data in that browser only.)

## 4. Expose it over HTTPS on your own domain

Put GymYar behind something that terminates TLS for a hostname you control, then point it at
the `web` container. Pick whichever you already run:

### Option A — Cloudflare Tunnel (no open ports)

1. Create a tunnel and route `gym.example.com` → `http://<docker-host>:8080`.
2. Cloudflare gives you HTTPS automatically.

### Option B — Caddy (automatic Let's Encrypt)

```caddy
gym.example.com {
    reverse_proxy localhost:8080
}
```

### Option C — Traefik / nginx / Nginx Proxy Manager

Route `gym.example.com` (HTTPS) → `web:80` (or `<docker-host>:8080`). Any reverse proxy works —
GymYar only needs the browser to reach it over `https://gym.example.com`.

Then set your domain in `.env` and restart:

```bash
# .env
RP_ID=gym.example.com
ORIGIN=https://gym.example.com
RP_NAME=GymYar
WEB_PORT=8080
```

```bash
docker compose up -d
```

Visit `https://gym.example.com`, create your profile, and add it to your home screen
(iOS: Share → Add to Home Screen · Android: ⋮ → Add to Home screen).

> Changing `RP_ID` later invalidates existing passkeys — they were bound to the old hostname.
> Pick your domain before people register.

## 5. Before you call it production

Four settings, and the first one is not optional:

```bash
SESSION_SECRET=          # openssl rand -hex 32
SEED_DEMO=               # empty — you do not want demo accounts on a real instance
RATE_LIMIT=on            # counted per account, not per IP address
SESSION_DAYS=90
```

**`SESSION_SECRET` is required.** The API image runs with `NODE_ENV=production`, and the API
refuses to start without a secret rather than inventing one — a generated secret changes when the
container is replaced, which signs every user out on every deploy.

Leave `RATE_LIMIT` on for anything reachable from the internet: the drafting endpoints call a
language model, so an unthrottled loop spends your money. Requests are counted against the
signed-in account rather than the IP address, because many users share one carrier address and
counting by address lets one of them lock out the rest.

Two optional subsystems are configured entirely in `.env`, and both are documented inline in
[`.env.example`](../.env.example): the **language model** — fully optional, and with no key set
plans, reviews and text logging all still work, in template wording rather than prose — and
**billing**, which is off unless you set a merchant id, in which case coaching is free on your
instance and no subscription row is ever written.

One more, if anybody but you can sign up:

```bash
MAX_MEDIA_BYTES_PER_USER=2147483648   # 2 GB each; 0 is unlimited
```

Form-check video, progress photos and voice notes go on a disk you are paying for, and an
upload endpoint with no ceiling is a storage bill somebody else gets to write. The default is
2 GB per account — roughly thirty clips and a few hundred photographs. Unlimited is the right
answer for an instance you and your training partners use and the wrong one for an open signup
form.

Deleted media is removed by a sweeper that runs inside the API container every fifteen minutes,
so there is no cron job to set up. Deleting an attachment hides it immediately and erases it on
the next pass; until then the bytes are still on the volume, which is worth knowing if somebody
asks you to prove a file is gone.

## 6. Who can join

By default anyone who can reach the URL can create their own profile, and each gets isolated
data: open signup, no admin.

To control who gets in, turn on invite-only and promote yourself to admin:

```bash
# .env
INVITE_ONLY=true
```

Admin is a column on the user row rather than an environment variable, so there is no way to be
admin of an instance you have not registered on. Register first, then:

```bash
docker compose exec db psql -U gymyar -d gymyar -c "update users set is_admin = true where email = 'you@example.com'"
```

Sign out and back in, and Settings grows an **Admin dashboard**: everyone on the instance with
their session count and when they last trained, the ability to disable an account — signed out
and locked out until you re-enable it — and generating and revoking invite codes. It is gated
server-side on `is_admin`, so it needs no separate login. Existing accounts keep working when you
switch invite-only on.

Prefer to keep the whole thing off the open internet? A VPN or an auth proxy (Authelia,
Cloudflare Access…) in front still works, and composes with the above.

## 7. Backups

**Two things, and only one of them is the database.**

Both, in one step, into `./backups`:

```bash
./infra/scripts/backup.sh --verify
```

`--verify` restores the dump it just took into a throwaway Postgres container and counts what
came back against what went in. Run it that way at least once, and on whatever schedule you
can stand: a backup nobody has restored is a hypothesis, and a truncated upload, a wrong `-U`
or a dump taken against the wrong database all look like success at the time. Putting one back
is `./infra/scripts/restore.sh <dump> [media]`, which refuses a target that already has
accounts in it unless you pass `--force`.

The rest of this section is what those two scripts do, because you should be able to do it by
hand — on a machine that has the archive and not this repository, for one.

```bash
docker compose exec -T db pg_dump -U gymyar gymyar | gzip > gymyar-$(date +%F).sql.gz
```

Restore into an empty database:

```bash
gunzip -c gymyar-2026-08-23.sql.gz | docker compose exec -T db psql -U gymyar -d gymyar
```

That dump holds every profile, passkey credential, coaching relationship and set ever logged.
Take it on a schedule and keep it somewhere that is not the same disk.

**It does not hold uploaded media.** Form-check video, progress photos and voice notes live on
the `media` volume, and the database holds only the rows describing them. Restore the dump
alone and you get an instance where every attachment is a broken link — the rows are all there,
pointing at bytes that are not. So take the volume too:

```bash
docker run --rm -v gymyar_media:/data -v "$PWD":/out alpine tar czf /out/gymyar-media-$(date +%F).tar.gz -C /data .
```

and put it back the same way:

```bash
docker run --rm -v gymyar_media:/data -v "$PWD":/in alpine tar xzf /in/gymyar-media-2026-08-25.tar.gz -C /data
```

The two are not required to be from the same instant. An attachment row whose bytes are missing
renders as unavailable rather than breaking the screen around it, and bytes with no row are
swept up. A media archive an hour older than the database is a handful of unavailable clips, not
a broken restore.

`./media` — the 1,324 exercise images and GIFs — is a third thing and needs no backup at all:
it is re-downloaded on first boot if the directory is empty. Individual users can also
export their own training as JSON from **Settings → Data**, which is a per-user convenience and
not an instance backup — it carries no other accounts, no credentials and no coaching state.

## 8. Email, and getting back into an account

Somebody will forget their password. Without a mail relay there is nothing GymYar can do about
that, so the feature is simply not offered: `passwordReset` is false, the app does not show the
link, and the endpoint refuses. Passkeys are unaffected — their recovery is the platform's job.

To turn it on, point it at a relay:

```bash
MAIL_TRANSPORT=smtp
MAIL_SMTP_HOST=smtp.example.com
MAIL_SMTP_PORT=587
MAIL_SMTP_USER=
MAIL_SMTP_PASS=
MAIL_FROM=GymYar <no-reply@example.com>
```

Two things decide whether this works in practice, and neither is in this file. **`ORIGIN` must
be your real HTTPS origin** — reset links are built from it, and an instance still on the
localhost default will send links nobody can open. And **`MAIL_FROM` should be a domain whose
SPF and DKIM records you control**, or the mail lands in spam and the feature looks broken
rather than misconfigured.

For an instance that is only you, there is a third option:

```bash
MAIL_TRANSPORT=log
```

The email is written to the server log instead of being sent — `docker compose logs api` and
the link is there. Fine when you are the only person with an account and the only person reading
the logs. Not fine on anything with a signup form: every reset link would pass through whatever
ships those logs.

The link is good for one hour and works once. Using it signs the account out on every other
device, which is the correct outcome when the reason for the reset is that somebody else had the
old password.

## 9. Signing in with a phone number

The two doors above both assume something a lot of this product's users do not have. A passkey
needs a device and a browser that will do WebAuthn. An email address in Iran is largely a thing
you keep in order to sign up to foreign services — and the reset mail in section 8 has to cross
a border to arrive, from a relay whose reputation is not yours, into filters that distrust the
whole origin.

What a coach and their clients all have is a mobile number. With an SMS gateway configured,
GymYar adds a third door: type your number, get a six-digit code, type it back. No password, and
the account is created on the spot if there was not one — the same screen either way, because
holding the SIM is the whole credential in both cases.

With no gateway configured it is not offered at all: `phoneAuth` is false, the app does not show
the button, and the endpoints refuse with a 501. Same shape as password reset.

### Getting a gateway

Two are implemented, both domestic and both reachable from Iranian hosting:

```bash
SMS_TRANSPORT=kavenegar
SMS_KAVENEGAR_KEY=...
SMS_KAVENEGAR_TEMPLATE=gymyar-otp
```

```bash
SMS_TRANSPORT=smsir
SMS_SMSIR_KEY=...
SMS_SMSIR_TEMPLATE_ID=100200
SMS_SMSIR_PARAM=CODE
```

**Register the pattern.** Both providers deliver one-time codes through a message body you
register with them and an operator approves — the template above. That is not a formality you
can skip: an unregistered bulk message to an Iranian handset is filtered, deprioritised or
dropped, and a code that arrives eleven minutes later is a signup that does not work. Approval
takes days, so do it before you need it. Leave the template unset and the code goes out as a
plain message instead, which is there so you can test the flow while you wait — not a
configuration to run on.

Write the pattern to say what `packages/sms/src/templates.js` says: the code, who it is from,
and that it lasts five minutes. Set `SMS_BRAND` if the approved sender name is not `RP_NAME` —
a message whose text names one thing and whose sender is another reads as a phishing attempt,
which is exactly what a person should be suspicious of.

For an instance that is only you, there is the same third option as email:

```bash
SMS_TRANSPORT=log
```

The code is written to the server log instead of being sent — `docker compose logs api` and it
is there. Fine when you are the only account. Not fine on anything with a signup form: every
sign-in code would pass through whatever ships those logs.

### What is fixed, and why

None of these are settings:

| | |
|---|---|
| A code lasts **5 minutes** | the message says so, in both languages |
| One number can be texted **once a minute** | and **5 times a day** |
| One code survives **5 wrong guesses** | then it is dead, whatever the rate limiter allows |

The last two are the ones standing between your SMS balance and anybody who notices the
endpoint, and they are counted per *number* rather than per caller — which is what matters,
because the number being texted belongs to a person who may not be the one asking. They live in
`packages/db/src/phone-codes.js`.

Codes are stored as `HMAC(key, phone + code)` and never in the clear, with the key derived from
`SESSION_SECRET`. Rotating that secret invalidates every outstanding code, which costs somebody
one resend.

### Adding a number to an account that already exists

Settings has a row for it. Somebody who joined with a passkey on a laptop, or with an email
address, confirms a number the same way — a code, typed back — and can then open the app on
their phone with neither. Removing it is refused when it is the *only* way in: an account
created by phone has no password and no passkey, so taking its number away is not unlinking a
contact detail, it is deleting the credential.

A number belongs to one account. Confirming one that is already somebody else's fails with
`phone_taken`, and that is said only after a correct code — before then, this endpoint will no
more report who is registered than `/api/phone/start` will.

One thing worth knowing before you open signup: **`/api/phone/start` answers identically for a
number with an account and one without.** It will not tell a caller who trains here, which for a
coaching instance is a roster. The cost is that a new number is asked for a name one step later
than it otherwise would be — after a correct code, which is the first moment anyone is told the
number is new.

## 10. Notifications

GymYar can push a rest-timer-over alert to your phone or desktop even when the app is not open.
Turn it on per-profile in **Settings → Notifications** — it needs a signed-in profile and HTTPS,
see section 4.

This one needs server-side setup. Generate a VAPID pair **once** and keep it:

```bash
npx web-push generate-vapid-keys
```

```bash
# .env
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:you@example.com
```

Changing the pair later silently breaks every existing subscription, and nobody finds out until
their rest timer stops firing. With the keys unset the API reports notifications as unconfigured
and nothing is sent.

**Keep screen awake** (Settings → *During a workout*) has the same transport requirement: the
Wake Lock API is only available over HTTPS or on `http://localhost`, so on a plain-LAN-IP
instance the switch shows as unsupported. Nothing to configure server-side either way, and iOS
refuses the lock while the phone is in Low Power Mode.

## 11. Updating

```bash
git pull
docker compose up -d --build
```

Schema migrations run on boot, in order, and are recorded — so an upgrade is the same command as
a first install. `./media` and the database volume are untouched. The app shell is versioned, so
clients pick up the new build on their next load.

Take a backup before an upgrade that carries a migration (section 7). Migrations do not roll back.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No passkey prompt on my phone | You are on `http://` or an IP, not HTTPS. Set up a domain (section 4). |
| "verification failed" on login | `RP_ID`/`ORIGIN` do not match the URL in the address bar. Make them exact, restart. |
| The api container exits immediately | Read `docker compose logs api`. Most often `SESSION_SECRET must be set in production` (section 5). |
| Media did not download | `docker compose logs media`. Re-run `docker compose up -d`, or run `./infra/scripts/fetch-media.sh` on the host. |
| Port 8080 already in use | Set `WEB_PORT=9090` in `.env`, and update `ORIGIN` for local testing. |
| No "Notifications" option in Settings | Needs a signed-in profile, HTTPS (or `localhost`), and VAPID keys on the server (section 10). Guest mode cannot subscribe. |
| Everyone signed out after a deploy | `SESSION_SECRET` was not set, so a new one was generated. Set it and it stops. |
| A stuck login | Delete the cookie in your browser; sessions are just signed cookies. |
| Demo accounts on a real instance | `SEED_DEMO` was set on first boot. Clear it *first*, restart, then delete the four accounts — the seed skips only while `coach@gymyar.test` exists, so deleting them with `SEED_DEMO` still set recreates them on the next boot. |
| Signed-in users see an app with no sign-in | You deployed the *mobile* bundle. `npm run sync:mobile` leaves a backend-less build in `apps/client/dist`; deploy with `npm run build`. See [RELEASING.md](RELEASING.md). |
