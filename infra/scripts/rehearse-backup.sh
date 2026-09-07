#!/usr/bin/env bash
# Prove that a backup restores — attachments included — onto a stack that has never seen it.
#
#   ./infra/scripts/rehearse-backup.sh                      # throwaway project on port 18080
#   REHEARSAL_PORT=18090 ./infra/scripts/rehearse-backup.sh
#   KEEP=1 ./infra/scripts/rehearse-backup.sh               # leave the stack up afterwards
#
# backup.sh --verify already proves the *dump* restores: it counts rows in a throwaway Postgres.
# It cannot prove the half it is most worried about, because the failure this whole pair of
# scripts exists to prevent is not a bad dump — it is "somebody took half of one": a database
# full of attachment rows pointing at bytes that are on a volume nobody archived. A row count
# is identical either way. Only a client trying to open the file after the restore can tell,
# and until this script nothing ever did.
#
# So this stands up its own compose project (never yours — see the guard), makes an account,
# logs a session, uploads a form check and a progress photo, takes the two-part backup, then
# destroys every volume and boots a fresh stack. Onto that it restores the dump *alone* first
# and shows the attachment is a broken link, because that is the claim in docs/SELF_HOSTING.md
# section 7 and a claim nobody has demonstrated is a hope. Then it restores both halves and
# fetches the bytes back through a signed URL, byte for byte the same as what went in.
#
# It runs in CI after the compose smoke test, so it cannot rot without the build going red.
# Locally it needs docker and about three minutes; the images are the same ones a self-hoster
# builds, so a cache from `docker compose up --build` makes it faster.
set -euo pipefail
cd "$(dirname "$0")/../.."

# ------------------------------------------------------------------- guard ----
# This script runs `docker compose down -v`. A project name that belongs to a real instance is
# refused rather than obeyed, because "rehearsal" and "the production volumes are gone" must
# never be one typo apart. The default is a name nothing else uses.
PROJECT="${REHEARSAL_PROJECT:-gymyar-rehearsal}"
case "$PROJECT" in
  gymyar|"$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9_-')")
    echo "refusing to rehearse on project '$PROJECT': that is the name a real stack uses, and this script destroys its volumes." >&2
    echo "set REHEARSAL_PROJECT to something else, or leave it unset." >&2
    exit 2 ;;
esac
PORT="${REHEARSAL_PORT:-18080}"
BASE="http://127.0.0.1:$PORT"

export COMPOSE_PROJECT_NAME="$PROJECT" WEB_PORT="$PORT"
export SEED_DEMO=""            # no demo accounts: the restore guard has to find an empty database
export MSYS_NO_PATHCONV=1      # Git Bash on Windows rewrites `vol:/data` into a Windows path otherwise

STAMP="$(date +%s)"
# Under the repository rather than in $TMPDIR: the archive is written by a container into a
# bind mount, and a docker daemon inside a VM — Docker Desktop, Colima — only shares the
# directories it has been told about. The checkout is one of those on every machine that can
# build the images at all; /tmp on Git Bash is not, and backup.sh's own check said so.
OUT="$PWD/backups/rehearsal-$STAMP"; mkdir -p "$OUT"
JAR="$(mktemp)"; JPEG="$(mktemp)"; PNG="$(mktemp)"
EMAIL="rehearsal-$STAMP@test.local"; PASSWORD="rehearsal-password"
W="rehearsal-w-$STAMP"

step() { printf '\n▸ %s\n' "$1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }
on_exit() {
  status=$?
  rm -f "$JAR" "$JPEG" "$PNG"
  if [ "$status" -ne 0 ]; then
    # On a runner nobody can inspect, the log is the inspection.
    [ -z "${CI:-}" ] || docker compose logs --no-color --tail 100 api 2>&1 | sed 's/^/  /' >&2
    echo "rehearsal: failed. The stack is left up for inspection:" >&2
    echo "  docker compose -p $PROJECT ps; docker compose -p $PROJECT logs api" >&2
    echo "  backups in $OUT" >&2
    echo "  remove with: docker compose -p $PROJECT down -v" >&2
  elif [ "${KEEP:-0}" = "1" ]; then
    echo "rehearsal: stack left up (KEEP=1) at $BASE — remove with: docker compose -p $PROJECT down -v"
  else
    docker compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$OUT"
  fi
}
trap on_exit EXIT

call() { # method path [body]
  curl -sS -X "$1" -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' ${3:+-d "$3"} "$BASE$2"
}
field() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=$2;if(v==null){console.error('missing: $2');process.exit(1)}console.log(v)" <<<"$1"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
wait_healthy() {
  for _ in $(seq 1 120); do
    curl -sf "$BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 2
  done
  fail "the stack at $BASE never answered /api/health"
}
# The bytes back through the signed link. Returns "<status> <sha256 of body>", so a 200 with the
# wrong bytes — a placeholder, an error page — cannot pass as the file.
fetch_sha() {
  local tmp; tmp="$(mktemp)"
  local code; code="$(curl -sS -o "$tmp" -w '%{http_code}' "$BASE$1")"
  echo "$code $(sha "$tmp")"; rm -f "$tmp"
}
signed_url() { # attachment id → its signed url, as the owner
  field "$(call GET "/api/attachments/$1")" "d.attachment.url"
}
login() {
  : > "$JAR"
  call POST /api/login/password "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
}

echo "rehearsal: project $PROJECT on $BASE"

# --------------------------------------------------------------- source ----
step "booting a fresh stack"
# Fresh means fresh: a previous run that failed leaves its stack up for inspection, and the
# manifest count below would then include that run's rows.
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --build >/dev/null 2>&1 || docker compose up -d --build
wait_healthy

step "an account, a finished session, and two uploads"
call POST /api/register/password "{\"name\":\"Rehearsal\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
# Spelled out column by column for the same reason smoke.sh does it: a key left off arrives as
# NULL against a NOT NULL column.
node -e 'const n=new Date().toISOString(),w=process.argv[1];process.stdout.write(JSON.stringify({changes:{routines:[{id:w+"-r",name:"Rehearsal",exercises:[{id:"0025",sets:3,reps:5}]}],workouts:[{id:w,started_at:n,finished_at:n,routine_name:"Rehearsal",sets:[{id:w+"-s1",workout_id:w,exercise_id:"0025",position:0,weight_kg:60,reps:5,seconds:null,distance_m:null,per_side:false,effort_value:null,effort_scale:null,is_warmup:false,done:true,done_at:n}]}]}}))' "$W" \
  | curl -sS -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' --data-binary @- "$BASE/api/sync" >/dev/null

# Real file headers: the server sniffs the leading bytes and refuses what it does not recognise.
# Different sizes so the two cannot be confused with each other by length.
node -e 'const b=Buffer.alloc(4096,0x20);Buffer.from([0xFF,0xD8,0xFF,0xE0,0,0x10,0x4A,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0]).copy(b);b[4094]=0xFF;b[4095]=0xD9;require("fs").writeFileSync(process.argv[1],b)' "$JPEG"
node -e 'const b=Buffer.alloc(3000,0x41);Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]).copy(b);require("fs").writeFileSync(process.argv[1],b)' "$PNG"

FORM=$(curl -sS -b "$JAR" -c "$JAR" -H 'Content-Type: application/octet-stream' --data-binary "@$JPEG" \
  "$BASE/api/attachments?subject=form_check&workout=$W&exercise=0025")
FORM_ID=$(field "$FORM" "d.attachment.id")
PHOTO=$(curl -sS -b "$JAR" -c "$JAR" -H 'Content-Type: application/octet-stream' --data-binary "@$PNG" \
  "$BASE/api/attachments?subject=progress&date=$(date +%F)")
PHOTO_ID=$(field "$PHOTO" "d.attachment.id")
FORM_SHA="$(sha "$JPEG")"; PHOTO_SHA="$(sha "$PNG")"

step "both open before the backup — otherwise the rest proves nothing"
[ "$(fetch_sha "$(signed_url "$FORM_ID")")" = "200 $FORM_SHA" ] || fail "the form check does not serve on the source stack"
[ "$(fetch_sha "$(signed_url "$PHOTO_ID")")" = "200 $PHOTO_SHA" ] || fail "the progress photo does not serve on the source stack"
echo "  form check $FORM_ID  progress photo $PHOTO_ID"

# --------------------------------------------------------------- backup ----
step "backup.sh --verify"
./infra/scripts/backup.sh --verify -o "$OUT"
DUMP="$(ls "$OUT"/gymyar-*.sql.gz)"; MEDIA="$(ls "$OUT"/gymyar-media-*.tar.gz)"
[ -s "$DUMP" ] && [ -s "$MEDIA" ] || fail "backup.sh did not leave both halves in $OUT"
grep -q '^attachments:2$' "$OUT"/gymyar-*.manifest.txt || fail "the manifest does not count the two attachments"

# ------------------------------------------------------ a stack that has never seen it ----
step "destroying every volume and booting again, empty"
docker compose down -v >/dev/null 2>&1
docker compose up -d >/dev/null 2>&1
wait_healthy
# Proof that it is empty: the account is gone. Not `-o /dev/null`: with path conversion off
# (above), a Windows curl is handed that name literally and cannot open it. A file it can.
: > "$JAR"
GONE=$(curl -sS -o "$JAR.discard" -w '%{http_code}' -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" "$BASE/api/login/password"; rm -f "$JAR.discard")
[ "$GONE" != "200" ] || fail "the fresh stack still knows the account — the volumes were not destroyed"

# ---------------------------------------------- the failure the docs warn about, shown ----
step "restoring the dump alone: the rows come back and the bytes do not"
./infra/scripts/restore.sh "$DUMP"
wait_healthy
login
HALF="$(fetch_sha "$(signed_url "$FORM_ID")")"
case "$HALF" in
  "200 $FORM_SHA") fail "the form check served after a dump-only restore — the media volume must have survived, which means the rehearsal is not testing a fresh stack" ;;
  200*) fail "a dump-only restore served *something* at the form check's link ($HALF) — a 200 with the wrong bytes is worse than a 404" ;;
esac
echo "  attachment row present, link answers ${HALF%% *}: the broken link, as documented"

# ------------------------------------------------------------ both halves ----
step "restoring both halves"
# --force: the half-restore above put the account back, and the guard is right to notice.
./infra/scripts/restore.sh --force "$DUMP" "$MEDIA"
wait_healthy
login
[ "$(fetch_sha "$(signed_url "$FORM_ID")")" = "200 $FORM_SHA" ] || fail "the form check did not come back byte for byte"
[ "$(fetch_sha "$(signed_url "$PHOTO_ID")")" = "200 $PHOTO_SHA" ] || fail "the progress photo did not come back byte for byte"
# And the training around them, so this is a restore of an instance and not of two files.
SETS=$(field "$(call GET /api/sync/all)" "d.changes.workouts[0].sets.length")
[ "$SETS" = "1" ] || fail "the restored session has $SETS sets, wanted 1"

echo
echo "rehearsal: all good — dump and media restored onto a fresh stack, both attachments open, bytes identical"
