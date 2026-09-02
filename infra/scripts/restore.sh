#!/usr/bin/env bash
# Put a GymYar backup back. The inverse of backup.sh, and the destructive half of the pair.
#
#   ./infra/scripts/restore.sh backups/gymyar-2026-08-27-101500.sql.gz
#   ./infra/scripts/restore.sh backups/gymyar-….sql.gz backups/gymyar-media-….tar.gz
#   ./infra/scripts/restore.sh --force backups/gymyar-….sql.gz     # over a database with rows in it
#
# This writes over an instance. The guard is deliberate and it is the default: a restore into a
# database that already has accounts in it is either a disaster recovery or a mistake, and the
# two look identical from here — so the second one has to be spelled. Without --force it refuses
# the moment it finds a user row, which is the case where somebody has typed the wrong -f or is
# restoring onto the wrong server.
#
# The media archive is optional and separate for the same reason it is separate in backup.sh:
# the two halves are not required to be from the same instant, and an attachment row whose bytes
# have not arrived yet renders as unavailable rather than breaking the screen around it.
set -euo pipefail

FORCE=0; DUMP=""; MEDIA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \?//'; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; exit 2 ;;
    *) if [ -z "$DUMP" ]; then DUMP="$1"; else MEDIA="$1"; fi; shift ;;
  esac
done
[ -n "$DUMP" ] || { echo "usage: restore.sh [--force] <dump.sql.gz> [media.tar.gz]" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 2; }
[ -z "$MEDIA" ] || [ -f "$MEDIA" ] || { echo "no such media archive: $MEDIA" >&2; exit 2; }

# Read, not sourced, for the reasons set out in backup.sh: `. ./.env` executes the file, and on a
# .env saved by a Windows editor it assigns values with a trailing carriage return — asking for a
# role under a name indistinguishable, in the error message, from one that exists. There it cost
# a backup. Here it arrives at the guard below, and the guard is the only thing between a
# mistyped path and `drop schema public cascade`.
env_get() { # env_get KEY → the last assignment of KEY in .env, unquoted, carriage return gone
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" .env | tail -n 1 | tr -d '\r' \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
PGUSER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; PGUSER="${PGUSER:-gymyar}"
PGDB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}";       PGDB="${PGDB:-gymyar}"

# Asked of compose rather than of node, which is not on the PATH of a non-interactive ssh session
# — and a restore is run from one more often than a backup is.
PROJECT="${COMPOSE_PROJECT_NAME:-$(env_get COMPOSE_PROJECT_NAME)}"
[ -n "$PROJECT" ] || PROJECT="$(docker compose ps --format '{{.Project}}' 2>/dev/null | head -n 1)"
[ -n "$PROJECT" ] || PROJECT="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
MEDIA_VOL="${PROJECT}_media"

step() { printf '  %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
psq() { docker compose exec -T db psql -qtAX -U "$PGUSER" -d "$PGDB" -c "$1"; }

# The api is stopped for the duration and started again at the end. Anything that exits in
# between leaves it stopped, which is the right thing — a half-restored database should not be
# served — but it used to leave it stopped without saying so, and an instance that is down for a
# reason nobody was told is indistinguishable from one that is down for no reason.
API_STOPPED=0
on_exit() {
  status=$?
  [ "$status" -eq 0 ] || [ "$API_STOPPED" -eq 0 ] || echo \
    "restore: the api is still stopped, on purpose — a half-restored database is not served.
  When you have decided what to do: docker compose start api" >&2
}
trap on_exit EXIT

echo "restore: $DUMP → $PGDB (project '$PROJECT')"

# The archive is checked before anything is dropped. Discovering that the dump is truncated
# after the target has been emptied is the one ordering that loses data outright.
step "checking the archive"
gzip -t "$DUMP" || fail "the dump is not a readable gzip stream"
grep -q 'PostgreSQL database dump complete' <(gunzip -c "$DUMP" | tail -20) \
  || fail "the dump has no completion marker — it was interrupted and is not safe to restore"
[ -z "$MEDIA" ] || tar tzf "$MEDIA" >/dev/null 2>&1 || fail "the media archive does not read as a tar.gz"

MANIFEST="${DUMP%.sql.gz}.manifest.txt"
[ -f "$MANIFEST" ] && { step "manifest:"; sed 's/^/    /' "$MANIFEST"; }

# ------------------------------------------------------------------- the guard ----
# This was one line: `EXISTING=$(psq 'select count(*) from users' 2>/dev/null || echo 0)`. It
# defeated the guard in precisely the case the guard is for. Every way the question can fail to
# be asked — the stack is down, POSTGRES_DB names a database that is not there, the role is wrong
# or ends in an invisible carriage return — came back 0, which reads as "empty, nothing to
# protect", and the next thing this script does is drop the schema. The comment below says
# stopping here is the whole point of the check; the check could not stop anything, because a
# question that could not be asked was being recorded as an answer of none.
psq 'select 1' >/dev/null 2>&1 || fail "cannot query $PGDB as $PGUSER.
  Is the stack up (docker compose ps), and are POSTGRES_USER and POSTGRES_DB right?
  Refusing to restore into a database it cannot read: a count of zero users here would
  mean 'the question failed', not 'the database is empty'."

# A database with no users *table* is a fresh one, and restoring onto it is the ordinary case. A
# database whose users table exists but cannot be counted is a different thing, and is no longer
# waved through as if it were the first.
if [ "$(psq "select to_regclass('public.users') is not null" | tr -d '[:space:]')" = "t" ]; then
  EXISTING="$(psq 'select count(*) from users' | tr -d '[:space:]')"
else
  EXISTING=0
fi
if [ "${EXISTING:-0}" != "0" ] && [ "$FORCE" != "1" ]; then
  fail "the target database already holds $EXISTING users.
  This would overwrite them. If that is the intention — a disaster recovery onto a live
  instance — pass --force. If it is not, you are pointed at the wrong server or the wrong
  POSTGRES_DB, and stopping here is the whole point of this check."
fi

# The API holds connections and will happily write during the restore, which is how a restore
# ends up with rows from two different databases in it. Stopped first, started at the end.
step "stopping the api"
docker compose stop api >/dev/null 2>&1 || true
API_STOPPED=1

# ------------------------------------------------------------------- database ----
# Dropping and recreating the schema rather than restoring over it: a plain pg_dump does not
# remove rows that the dump does not contain, so restoring over a live database leaves anything
# deleted since the backup still sitting there — an account that was closed comes back.
step "recreating the schema"
# `client_min_messages` because the cascade announces every one of the thirty-odd tables it is
# taking with it, on stderr, and a wall of "drop cascades to table …" reads like a failure in
# the middle of the one command here that cannot be undone.
psq 'set client_min_messages to warning; drop schema public cascade; create schema public;' >/dev/null \
  || fail "could not reset the schema"

step "restoring"
gunzip -c "$DUMP" | docker compose exec -T db psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" >/dev/null \
  || fail "the restore failed part-way — the database is now incomplete, and the dump is still on disk"

RU=$(psq 'select count(*) from users'); RS=$(psq 'select count(*) from workout_sets')
RM=$(psq 'select count(*) from schema_migrations')
step "$RU users, $RS sets, $RM migrations"

# ---------------------------------------------------------------------- media ----
if [ -n "$MEDIA" ]; then
  step "restoring the media volume ($MEDIA_VOL)"
  docker volume inspect "$MEDIA_VOL" >/dev/null 2>&1 || docker volume create "$MEDIA_VOL" >/dev/null
  MEDIA_DIR="$(cd "$(dirname "$MEDIA")" && pwd)"

  # The check at the top of this script proved the archive reads *here*. This proves it reads
  # *there* — before the rm below destroys what is on the volume. A daemon inside a VM (Colima,
  # Lima, Docker Desktop) shares only the directories it is configured to share, and mounts any
  # other as an empty one, so the tar is simply absent. In `rm -rf /data/* && tar xzf …` the rm
  # has already run by the time that is discovered: the failure lands after the media it was
  # replacing is gone, with the archive meant to replace it never in reach.
  docker run --rm -v "$MEDIA_DIR":/in alpine \
    sh -c "tar tzf '/in/$(basename "$MEDIA")' >/dev/null 2>&1" \
    || fail "the docker daemon cannot read $MEDIA.
  A daemon inside a VM shares only the directories it is configured to share, and silently mounts
  any other as empty. Nothing has been deleted. Move the archive to a shared directory — or add
  this one to the daemon's file sharing — and run this again."

  docker run --rm -v "$MEDIA_VOL":/data -v "$MEDIA_DIR":/in alpine \
    sh -c "rm -rf /data/* && tar xzf '/in/$(basename "$MEDIA")' -C /data" \
    || fail "the media restore failed"
  step "$(docker run --rm -v "$MEDIA_VOL":/data alpine sh -c 'find /data -type f | wc -l') files on the volume"
else
  # Said plainly rather than left to be discovered by a client tapping a video.
  ORPHANS=$(psq 'select count(*) from attachments' 2>/dev/null || echo 0)
  [ "$ORPHANS" = "0" ] || step "no media archive given — $ORPHANS attachment rows now point at bytes that may not be there"
fi

step "starting the api"
docker compose start api >/dev/null
API_STOPPED=0

# `docker compose start` returns when the container is running, which is a second or two before
# the API is answering — and in between, the instance serves 502. Waiting means "restore: all
# good" is a statement about the app rather than about the container.
for _ in $(seq 1 60); do
  docker compose exec -T api node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1 && break
  sleep 1
done
docker compose exec -T api node -e 'fetch("http://127.0.0.1:3000/api/health").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1 \
  || fail "the data is restored but the api did not come back — check: docker compose logs api"

echo "restore: all good"
