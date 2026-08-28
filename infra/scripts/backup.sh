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
[ -f .env ] && set -a && . ./.env && set +a || true
PGUSER="${POSTGRES_USER:-gymyar}"
PGDB="${POSTGRES_DB:-gymyar}"
PROJECT="$(docker compose config --format json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).name||"gymyar")}catch{console.log("gymyar")}})' || echo gymyar)"
MEDIA_VOL="${PROJECT}_media"

STAMP=$(date +%F-%H%M%S)
mkdir -p "$OUT"
DUMP="$OUT/gymyar-$STAMP.sql.gz"
MEDIA="$OUT/gymyar-media-$STAMP.tar.gz"
MANIFEST="$OUT/gymyar-$STAMP.manifest.txt"

step() { printf '  %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

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
MEDIA_FILES=$(docker run --rm -v "$MEDIA_VOL":/data alpine sh -c 'find /data -type f | wc -l')
step "$MEDIA_FILES files on the media volume"

# ------------------------------------------------------------------ manifest ----
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
{
  echo "taken:      $(date -Is)"
  echo "version:    $(node -p 'require("./package.json").version' 2>/dev/null || echo '?')"
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

# -------------------------------------------------------------------- verify ----
# Restores into a container that has never seen this instance, so nothing about the running
# stack can make a broken dump look fine. Torn down whichever way this exits.
if [ "$VERIFY" = "1" ]; then
  step "verifying: restoring into a throwaway database"
  VDB="gymyar-verify-$$"
  trap 'docker rm -f "$VDB" >/dev/null 2>&1 || true' EXIT
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
