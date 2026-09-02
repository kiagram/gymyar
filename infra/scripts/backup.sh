#!/usr/bin/env bash
# Take a GymYar backup: the database and the uploaded media, which are two things.
#
#   ./infra/scripts/backup.sh                 # into ./backups
#   ./infra/scripts/backup.sh -o /mnt/nas     # somewhere that is not this disk
#   ./infra/scripts/backup.sh --verify        # …and prove the dump restores
#
# docs/SELF_HOSTING.md section 7 has the same two commands written out by hand. This runs both,
# in one step, and writes a manifest beside them — because the failure this script exists to
# prevent is not "nobody took a backup", it is "somebody took half of one". A pg_dump holds
# every account, every set and every row describing an attachment; the bytes those rows point
# at live on the media volume and are not in it. Restore the dump alone and every clip in the
# instance is a broken link.
#
# --verify is the part worth running. A backup nobody has restored is a hypothesis: it restores
# the dump into a throwaway Postgres container, counts what came back and compares it with what
# went in. That catches a truncated upload, a wrong -U, a dump taken against an empty database
# by somebody who set POSTGRES_DB and forgot — none of which look like failures at the time.
set -euo pipefail

OUT="./backups"; VERIFY=0
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--out) OUT="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The same defaults docker-compose.yml uses, so this works with no .env at all — and reads .env
# when there is one, because an instance that changed POSTGRES_DB must be dumped by that name
# rather than by the default that happens to also exist on the server.
#
# Read, not sourced. `. ./.env` executes the file, which makes every backup a run of whatever is
# in it; and on a .env saved by a Windows editor it assigns values with a trailing carriage
# return. That is not a cosmetic difference. It is what reported
#     FATAL: role "gymyar" does not exist
# on an instance whose role is plainly gymyar — the name actually sent ended in a CR, and a CR
# is invisible in the very error message you would use to debug it. Shell environment wins over
# .env here, which is the precedence compose itself uses.
env_get() { # env_get KEY → the last assignment of KEY in .env, unquoted, carriage return gone
  [ -f .env ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=//p" .env | tail -n 1 | tr -d '\r' \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
PGUSER="${POSTGRES_USER:-$(env_get POSTGRES_USER)}"; PGUSER="${PGUSER:-gymyar}"
PGDB="${POSTGRES_DB:-$(env_get POSTGRES_DB)}";       PGDB="${PGDB:-gymyar}"

# The project name is what the media volume is named after, so getting it wrong means archiving
# nothing. Asked of compose, which is the only thing that truly knows; then of .env; then the
# directory name, normalised the way compose normalises it. It used to be asked of node — which
# is not on the PATH of every machine that runs a backup, and notably not on the PATH of a
# non-interactive ssh session, which is exactly how a backup gets run by anything automatic.
# When node was missing the fallback answered "gymyar" without comment: correct here, and
# silently wrong on any instance that had been renamed.
PROJECT="${COMPOSE_PROJECT_NAME:-$(env_get COMPOSE_PROJECT_NAME)}"
[ -n "$PROJECT" ] || PROJECT="$(docker compose ps --format '{{.Project}}' 2>/dev/null | head -n 1)"
[ -n "$PROJECT" ] || PROJECT="$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')"
MEDIA_VOL="${PROJECT}_media"

STAMP=$(date +%F-%H%M%S)
mkdir -p "$OUT"
DUMP="$OUT/gymyar-$STAMP.sql.gz"
MEDIA="$OUT/gymyar-media-$STAMP.tar.gz"
MANIFEST="$OUT/gymyar-$STAMP.manifest.txt"

step() { printf '  %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# A file that is not a backup must not be left sitting where backups are kept. The redirection
# below creates $DUMP before pg_dump has written one byte into it, so every failure from here on
# used to leave a plausible .sql.gz behind — twenty bytes, decompressing to nothing, filed by
# date beside the real ones and indistinguishable from them until the day you reach for it. This
# script's own header says the failure it exists to prevent is "somebody took half of one"; it
# was taking half of one. Now only a run that reaches the end leaves anything at all.
PARTIAL=("$DUMP" "$MEDIA" "$MANIFEST")
VDB=""
on_exit() {
  status=$?
  [ -z "$VDB" ] || docker rm -f "$VDB" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ "${#PARTIAL[@]}" -gt 0 ]; then
    rm -f "${PARTIAL[@]}"
    echo "backup: removed the incomplete files this run had written — there is no backup here" >&2
  fi
}
trap on_exit EXIT

echo "backup: $PGDB from project '$PROJECT' → $OUT"

# ------------------------------------------------------------------ database ----
step "dumping the database"
docker compose exec -T db pg_dump -U "$PGUSER" "$PGDB" | gzip > "$DUMP" \
  || fail "pg_dump failed — is the stack up? (docker compose ps)"

# A gzip that does not decompress is a file, not a backup. `gzip -t` reads the whole stream, so
# this also catches the truncated write that a full disk produces without an error anywhere.
gzip -t "$DUMP" || fail "the dump is not a readable gzip stream"
grep -q 'PostgreSQL database dump complete' <(gunzip -c "$DUMP" | tail -20) \
  || fail "the dump has no completion marker — pg_dump was interrupted"

# What went in, so --verify has something to compare against and the manifest has something to
# state. Counted from the live database rather than from the dump: the point is to notice a
# dump that disagrees with the instance it was taken from.
counts() { # runs a query against the live db, one row of ints
  docker compose exec -T db psql -qtAX -U "$PGUSER" -d "$PGDB" -c "$1"
}
USERS=$(counts 'select count(*) from users')
SETS=$(counts 'select count(*) from workout_sets')
ATTACH=$(counts "select count(*) from attachments" 2>/dev/null || echo 0)
MIGRATIONS=$(counts 'select count(*) from schema_migrations')
step "$USERS users, $SETS sets, $ATTACH attachments, $MIGRATIONS migrations applied"

# --------------------------------------------------------------------- media ----
# The rows above describe files that are not in the dump. Taken second and separately, and
# deliberately not in the same transaction as anything: the two are not required to be from the
# same instant. An attachment row whose bytes are missing renders as unavailable rather than
# breaking the screen around it, and bytes with no row are swept up.
step "archiving the media volume ($MEDIA_VOL)"
docker volume inspect "$MEDIA_VOL" >/dev/null 2>&1 \
  || fail "no volume named $MEDIA_VOL — check the compose project name"
docker run --rm -v "$MEDIA_VOL":/data -v "$(cd "$OUT" && pwd)":/out alpine \
  tar czf "/out/$(basename "$MEDIA")" -C /data . || fail "the media archive failed"

# The dump gets checked because it is piped out through this shell; the media archive is written
# by a container into a bind mount, and so has to be checked for having arrived at all. It can
# fail to: a docker daemon inside a VM — Colima, Lima, Docker Desktop — shares only the
# directories it has been configured to share, and mounts one it cannot see as an empty
# directory. It takes the tar happily and leaves it in the VM. Nothing errors. tar exits 0. The
# archive is simply not here, and the only previous sign of it was sha256sum complaining on
# stderr while the last line of the script said "all good".
[ -s "$MEDIA" ] || fail "the media archive is not in $OUT — the docker daemon wrote it somewhere this machine cannot see.
  A daemon inside a VM shares only the directories it is configured to share, and silently mounts
  any other as empty. Back up to a shared directory, or add this one to the daemon's file sharing."
gzip -t "$MEDIA" || fail "the media archive is not a readable gzip stream"
MEDIA_FILES=$(docker run --rm -v "$MEDIA_VOL":/data alpine sh -c 'find /data -type f | wc -l')
step "$MEDIA_FILES files on the media volume"

# ------------------------------------------------------------------ manifest ----
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
# Read out of package.json rather than asked of node, for the same reason as the project name.
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json 2>/dev/null | head -n 1)"
{
  # Not `date -Is`: that is a GNU spelling, and BSD date — the date on the Mac this instance
  # runs on — rejects it, which left every manifest it ever wrote with a blank taken: line.
  echo "taken:      $(date +%Y-%m-%dT%H:%M:%S%z)"
  echo "version:    ${VERSION:-?}"
  echo "commit:     $(git rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo "database:   $PGDB as $PGUSER"
  echo "migrations: $MIGRATIONS"
  echo "users:      $USERS"
  echo "sets:       $SETS"
  echo "attachments:$ATTACH"
  echo "mediafiles: $MEDIA_FILES"
  echo "dump:       $(basename "$DUMP")  $(sha "$DUMP")"
  echo "media:      $(basename "$MEDIA")  $(sha "$MEDIA")"
} > "$MANIFEST"

# Complete, checked and hashed: from here the files stand on their own, so stop treating them as
# this run's debris. It matters for --verify, which can fail for reasons that say nothing about
# the dump — a throwaway container that never came up on a busy machine. A failure there should
# leave the backup where you can look at it, not delete the evidence.
PARTIAL=()

# -------------------------------------------------------------------- verify ----
# Restores into a container that has never seen this instance, so nothing about the running
# stack can make a broken dump look fine. Torn down whichever way this exits.
if [ "$VERIFY" = "1" ]; then
  step "verifying: restoring into a throwaway database"
  VDB="gymyar-verify-$$"   # torn down by on_exit, whichever way this ends
  docker run -d --name "$VDB" -e POSTGRES_PASSWORD=verify -e POSTGRES_USER="$PGUSER" \
    -e POSTGRES_DB="$PGDB" postgres:16-alpine >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$VDB" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$VDB" pg_isready -U "$PGUSER" -d "$PGDB" >/dev/null 2>&1 \
    || fail "the verify container never became ready"

  gunzip -c "$DUMP" | docker exec -i "$VDB" psql -q -v ON_ERROR_STOP=1 -U "$PGUSER" -d "$PGDB" >/dev/null \
    || fail "the dump did not restore cleanly"

  vcounts() { docker exec "$VDB" psql -qtAX -U "$PGUSER" -d "$PGDB" -c "$1"; }
  RU=$(vcounts 'select count(*) from users'); RS=$(vcounts 'select count(*) from workout_sets')
  RM=$(vcounts 'select count(*) from schema_migrations')
  [ "$RU" = "$USERS" ] || fail "restored $RU users, the instance has $USERS"
  [ "$RS" = "$SETS" ]  || fail "restored $RS sets, the instance has $SETS"
  [ "$RM" = "$MIGRATIONS" ] || fail "restored $RM migrations, the instance has $MIGRATIONS"
  step "restored and counted: $RU users, $RS sets, $RM migrations — all agree"
fi

echo "backup: all good"
echo "  $DUMP"
echo "  $MEDIA"
echo "  $MANIFEST"
[ "$VERIFY" = "1" ] || echo "  (run again with --verify to prove the dump restores)"
