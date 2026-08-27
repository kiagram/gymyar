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
- Open **http://localhost:8080** and create a profile.

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
| `web` | nginx: serves the built React app **and** proxies `/api` to the API, so everything is one origin — which WebAuthn requires. Also serves the exercise media. | none |
| `api` | Fastify on :3000, internal only. Migrates and seeds on every boot; both are idempotent, so every boot after the first is a no-op. | none |
| `db` | Postgres 16. **Every account and every set ever logged.** | `gymyar_db` volume |
| `media` | One-shot: clones the exercise dataset into `./media`, then exits. Skipped if the files are already there. | `./media` |

The exercise media is © [Gym visual](https://gymvisual.com/) and licensed separately from this
code — see [NOTICE.md](../NOTICE.md). Fine for a personal instance; a commercial deployment needs
its own licence or its own assets.

## 3. Sign-in, and why HTTPS matters

GymYar signs you in two ways: **passkeys** (WebAuthn) and **email + password**. Passkeys are
what the UI leads with; the password path exists because "sign up" cannot be a dead end on a
device whose browser will not do passkeys.

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

## 9. Notifications

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

## 10. Updating

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
| No "Notifications" option in Settings | Needs a signed-in profile, HTTPS (or `localhost`), and VAPID keys on the server (section 8). Guest mode cannot subscribe. |
| Everyone signed out after a deploy | `SESSION_SECRET` was not set, so a new one was generated. Set it and it stops. |
| A stuck login | Delete the cookie in your browser; sessions are just signed cookies. |
| Demo accounts on a real instance | `SEED_DEMO` was set on first boot. Clear it *first*, restart, then delete the four accounts — the seed skips only while `coach@gymyar.test` exists, so deleting them with `SEED_DEMO` still set recreates them on the next boot. |
| Signed-in users see an app with no sign-in | You deployed the *mobile* bundle. `npm run sync:mobile` leaves a backend-less build in `apps/client/dist`; deploy with `npm run build`. See [RELEASING.md](RELEASING.md). |
