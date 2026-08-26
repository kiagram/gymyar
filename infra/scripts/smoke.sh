#!/usr/bin/env bash
# End-to-end smoke test against a running instance. Drives the whole coaching flow over real
# HTTP — signup, invite, accept, propose, accept — and fails loudly on the first bad status.
#
#   ./infra/scripts/smoke.sh http://localhost:8080
set -euo pipefail
BASE="${1:-http://localhost:3000}"
COACH_JAR=$(mktemp); CLIENT_JAR=$(mktemp)
trap 'rm -f "$COACH_JAR" "$CLIENT_JAR"' EXIT
STAMP=$(date +%s)
# Row ids carry the stamp for the same reason the email addresses do: a client-minted id is
# final, and `smoke-r1` written by one run is a row the next run cannot write — the upsert is
# scoped to its owner, so a second run against the same database used to fail on a collision
# with the first run's account. Only ever noticed against a persistent instance, which is
# exactly what somebody smoke-testing their own deployment has.
R1="smoke-r1-$STAMP"; W1="smoke-w1-$STAMP"

call() { # jar method path [body]
  local jar=$1 method=$2 path=$3 body=${4:-}
  curl -sS -X "$method" -b "$jar" -c "$jar" \
    -H 'Content-Type: application/json' \
    ${body:+-d "$body"} "$BASE$path"
}
field() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=$2;if(v==null){console.error('missing: $2');process.exit(1)}console.log(v)" <<<"$1"; }
step() { printf '  %s\n' "$1"; }

echo "smoke: $BASE"
step "health";  call "$COACH_JAR" GET /api/health >/dev/null

step "coach signs up"
COACH=$(call "$COACH_JAR" POST /api/register/password \
  "{\"name\":\"Smoke Coach\",\"email\":\"smoke-coach-$STAMP@test.local\",\"password\":\"smoke-test-password\",\"asCoach\":true}")
field "$COACH" "d.user.id" >/dev/null

step "client signs up"
CLIENT=$(call "$CLIENT_JAR" POST /api/register/password \
  "{\"name\":\"Smoke Client\",\"email\":\"smoke-client-$STAMP@test.local\",\"password\":\"smoke-test-password\"}")
CLIENT_ID=$(field "$CLIENT" "d.user.id")

step "client logs a session"
call "$CLIENT_JAR" POST /api/sync \
  "{\"changes\":{\"routines\":[{\"id\":\"$R1\",\"name\":\"My own\",\"exercises\":[{\"id\":\"0025\",\"sets\":3,\"reps\":5}]}]}}" >/dev/null

# A finished session too — a form check has to hang off one, and the timestamps come from node
# rather than from a shell-quoted literal so this stays one payload rather than four escapes.
#
# Every column of the set is spelled out. `push` inserts a fixed column list, so a key left off
# here arrives as NULL against a NOT NULL column; the real client never notices because
# statemap.js always builds the whole row.
SESSION=$(mktemp)
node -e 'const n=new Date().toISOString(),w=process.argv[2];require("fs").writeFileSync(process.argv[1],JSON.stringify({changes:{workouts:[{id:w,started_at:n,finished_at:n,routine_name:"My own",sets:[{id:w+"-s1",workout_id:w,exercise_id:"0025",position:0,weight_kg:60,reps:5,seconds:null,distance_m:null,per_side:false,effort_value:null,effort_scale:null,is_warmup:false,done:true,done_at:n}]}]}}))' "$SESSION" "$W1"
curl -sS -b "$CLIENT_JAR" -c "$CLIENT_JAR" -H 'Content-Type: application/json' \
  --data-binary "@$SESSION" "$BASE/api/sync" >/dev/null
rm -f "$SESSION"

step "coach invites, client accepts"
CODE=$(field "$(call "$COACH_JAR" POST /api/coach/invites '{"scopes":["programmes","workouts"]}')" "d.invite.code")
call "$CLIENT_JAR" POST "/api/invites/$CODE/accept" '{"scopes":["programmes"]}' >/dev/null

step "coach sees the client"
field "$(call "$COACH_JAR" GET /api/coach/clients)" "d.clients.length" >/dev/null

step "coach proposes; client's routine must not change"
call "$COACH_JAR" POST "/api/coach/clients/$CLIENT_ID/propose" \
  "{\"routineId\":\"$R1\",\"payload\":{\"name\":\"Coach version\",\"exercises\":[{\"id\":\"0025\",\"sets\":5,\"reps\":5}]},\"note\":\"five across\"}" >/dev/null
NAME=$(field "$(call "$CLIENT_JAR" GET /api/sync/all)" "d.changes.routines[0].name")
[ "$NAME" = "My own" ] || { echo "FAIL: proposal overwrote the client ($NAME)"; exit 1; }

step "client accepts; now it changes"
PID=$(field "$(call "$CLIENT_JAR" GET /api/proposals)" "d.proposals[0].id")
call "$CLIENT_JAR" POST "/api/proposals/$PID/accept" '{}' >/dev/null
NAME=$(field "$(call "$CLIENT_JAR" GET /api/sync/all)" "d.changes.routines[0].name")
[ "$NAME" = "Coach version" ] || { echo "FAIL: accept did not apply ($NAME)"; exit 1; }

# ---------------------------------------------------------------- media ----
#
# The only place the whole serving path is exercised. In CI this runs against the compose stack,
# which sets STORAGE_ACCEL=1 — so this is the one test that proves nginx and the API agree about
# X-Accel-Redirect. Every unit test above it runs with Node serving the bytes itself, and would
# pass just as happily against a deployment that answers every media request with an empty body.

step "client uploads a form check"
JPEG=$(mktemp); trap 'rm -f "$COACH_JAR" "$CLIENT_JAR" "$JPEG"' EXIT
# A real JPEG: the server sniffs the leading bytes and refuses anything it does not recognise,
# so a file of zeroes would be rejected here and prove nothing.
node -e 'const b=Buffer.alloc(2048,0x20);Buffer.from([0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0]).copy(b);b[2046]=0xFF;b[2047]=0xD9;require("fs").writeFileSync(process.argv[1],b)' "$JPEG"
UP=$(curl -sS -b "$CLIENT_JAR" -c "$CLIENT_JAR" -H 'Content-Type: application/octet-stream' \
  --data-binary "@$JPEG" \
  "$BASE/api/attachments?subject=form_check&workout=$W1&exercise=0025")
MEDIA_URL=$(field "$UP" "d.attachment.url")
[ "$(field "$UP" "d.attachment.mime")" = "image/jpeg" ] || { echo "FAIL: type was not sniffed"; exit 1; }

step "the signed link serves the bytes"
# Follows whatever the deployment does — nginx's internal redirect, or the API's own stream.
# An empty body here is the failure this step exists to catch.
SERVED=$(curl -sS -o /dev/null -w '%{http_code} %{size_download}' "$BASE$MEDIA_URL")
[ "$SERVED" = "200 2048" ] || { echo "FAIL: media served '$SERVED', wanted '200 2048'"; exit 1; }

step "an unsigned link serves nothing"
BARE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE${MEDIA_URL%%\?*}")
[ "$BARE" = "403" ] || { echo "FAIL: unsigned media returned $BARE, wanted 403"; exit 1; }

step "a document is refused whatever it claims to be"
HTML=$(mktemp)
printf '<!DOCTYPE html><script>alert(1)</script>' > "$HTML"
BAD=$(curl -sS -o /dev/null -w '%{http_code}' -b "$CLIENT_JAR" -H 'Content-Type: image/jpeg' \
  --data-binary "@$HTML" \
  "$BASE/api/attachments?subject=form_check&workout=$W1&exercise=0025")
rm -f "$HTML"
[ "$BAD" = "415" ] || { echo "FAIL: an HTML upload returned $BAD, wanted 415"; exit 1; }

step "a scope the client did not grant hides the video too"
# This client shared programmes and nothing else — see the accept above. So the coach can read
# the proposal they authored and not one frame of what was filmed, which is the same rule the
# body-weight check below states about numbers, applied to a camera.
CHECKS=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COACH_JAR" "$BASE/api/coach/clients/$CLIENT_ID/attachments?workout=$W1")
[ "$CHECKS" = "403" ] || { echo "FAIL: form checks returned $CHECKS without the workouts scope, wanted 403"; exit 1; }
# And photographs are their own grant, never implied by any of the others.
PHOTOS=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COACH_JAR" "$BASE/api/coach/clients/$CLIENT_ID/progress")
[ "$PHOTOS" = "403" ] || { echo "FAIL: progress photos returned $PHOTOS without the scope, wanted 403"; exit 1; }

step "with the scope, the coach sees it"
# Granted from the client's side, which is the only side that can grant it.
LINK=$(field "$(call "$CLIENT_JAR" GET /api/coaches)" "d.coaches[0].id")
call "$CLIENT_JAR" POST "/api/coaches/$LINK/scopes" '{"scopes":["programmes","workouts"]}' >/dev/null
COUNT=$(field "$(call "$COACH_JAR" GET "/api/coach/clients/$CLIENT_ID/attachments?workout=$W1")" "d.attachments.length")
[ "$COUNT" = "1" ] || { echo "FAIL: coach saw $COUNT form checks, wanted 1"; exit 1; }
# The signed URL the coach was handed is one they can actually follow.
COACH_BYTES=$(curl -sS -o /dev/null -w '%{http_code}' -b "$COACH_JAR" "$BASE$(field "$(call "$COACH_JAR" GET "/api/coach/clients/$CLIENT_ID/attachments?workout=$W1")" "d.attachments[0].url")")
[ "$COACH_BYTES" = "200" ] || { echo "FAIL: coach could not follow the link they were given ($COACH_BYTES)"; exit 1; }
# Put it back, so the body-weight check below still tests what it was written to test.
call "$CLIENT_JAR" POST "/api/coaches/$LINK/scopes" '{"scopes":["programmes"]}' >/dev/null

step "scope is honoured"
BW=$(call "$COACH_JAR" GET "/api/coach/clients/$CLIENT_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.bodyweight===undefined?'hidden':'LEAKED')")
[ "$BW" = "hidden" ] || { echo "FAIL: body weight visible without the scope"; exit 1; }

echo "smoke: all good"
