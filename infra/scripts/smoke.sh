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
# The only place the whole serving path is exercised. CI runs this script twice: once against
# `npm start` with Node serving the bytes itself, and once against the compose stack, which sets
# STORAGE_ACCEL=1 and puts nginx in front. The second run is the one that proves nginx and the
# API agree about X-Accel-Redirect, and it is the only test in the project that can — every unit
# test above would pass just as happily against a deployment that answers every media request
# with a 404, which for a while is exactly what the compose stack did for photographs.

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

# ------------------------------------------------------- counters, and the web layer ----

step "the instance counts itself, with nobody signed in"
# No cookie jar on this one on purpose: the point of the endpoint is that it answers without
# an account, and passing a jar would hide a `requireUser` accidentally added to it later.
STATS=$(curl -sS "$BASE/api/public/stats")
field "$STATS" "d.stats.athletes" >/dev/null
field "$STATS" "d.stats.exercises" >/dev/null
node -e 'const d=JSON.parse(process.argv[1]);if(JSON.stringify(d).match(/@|smoke-/))throw new Error("public stats named somebody");if(Object.values(d.stats).some(v=>typeof v!=="number"))throw new Error("public stats returned a non-number")' "$STATS"

# The rest of this section only means anything behind nginx. CI runs this script twice — once
# against `npm start`, which is the API on its own with no site to serve, and once against the
# compose stack. Whether `/` answers at all is what tells the two apart.
SITE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/")
if [ "$SITE" = "200" ]; then
  step "the project site is the front door"
  curl -sS "$BASE/" | grep -q 'id="instance"' \
    || { echo "FAIL: / did not serve the project site"; exit 1; }

  step "the front door is in Persian, and English is one level down"
  # Which language sits on the root is a product decision, not a detail: Iran is this
  # project's market, and the page a visitor gets before choosing anything is the one the
  # site is for. Nothing else in the tree would notice the two being swapped back.
  curl -sS "$BASE/" | grep -q '<html lang="fa" dir="rtl">' \
    || { echo "FAIL: / is not the Persian page"; exit 1; }
  curl -sS "$BASE/en/" | grep -q '<html lang="en">' \
    || { echo "FAIL: /en/ is not the English page"; exit 1; }

  step "the old Persian prefix still resolves"
  # /fa/ was Persian's address for the whole of the first release. Links to it exist.
  FA=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/fa/docs.html")
  [ "${FA#* }" = "$BASE/docs.html" ] || { echo "FAIL: /fa/docs.html went to '$FA', wanted a 301 to $BASE/docs.html"; exit 1; }

  step "the privacy policy is where the stores were told it is"
  # Not a nicety: Health Connect refuses to work for an app whose declared policy URL does not
  # resolve, and Bazaar and Myket both take the address at submission. A 404 here is a build
  # that cannot ship, discovered by a reviewer rather than by us.
  for P in /privacy.html /en/privacy.html; do
    GOT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$P")
    [ "$GOT" = "200" ] || { echo "FAIL: $P returned $GOT — the declared privacy policy is not there"; exit 1; }
  done

  step "the typeface and the mark shipped with it"
  # Both are copied in at build time from outside apps/site — the font from the client and the
  # mark from logo/ — so a Dockerfile edit can drop either without any page failing to serve.
  # Persian falling back to whatever face the visitor's machine carries is exactly the failure
  # bundling it was meant to end, and it is invisible from a status code on the HTML.
  for A in /fonts/vazirmatn-variable.woff2 /brand/gymyar-mark.svg; do
    GOT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$A")
    [ "$GOT" = "200" ] || { echo "FAIL: $A returned $GOT — brand assets did not ship"; exit 1; }
  done

  step "the app is one level down"
  curl -sS "$BASE/app/" | grep -q '<div id="root">' \
    || { echo "FAIL: /app/ did not serve the app shell"; exit 1; }

  step "the address without the slash redirects to it"
  RED=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/app")
  [ "${RED#* }" = "$BASE/app/" ] || { echo "FAIL: /app went to '$RED', wanted a 301 to $BASE/app/"; exit 1; }

  step "a deep link inside the app falls back to the app, not to the site"
  # The client routes through a HashRouter, so this path is not one of its routes — but the
  # fallback is what a reload of any future non-hash route depends on, and getting the site's
  # HTML here instead would be silent.
  curl -sS "$BASE/app/anything" | grep -q '<div id="root">' \
    || { echo "FAIL: /app/anything did not fall back to the app shell"; exit 1; }

  step "and a wrong path on the site is a 404, not the app"
  MISS=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/no-such-page")
  [ "$MISS" = "404" ] || { echo "FAIL: /no-such-page returned $MISS, wanted 404"; exit 1; }

  step "an exercise's artwork is a link that resolves"
  # The library stores `image_url` and `animation_url` rather than deriving them, so they are
  # the one kind of value here that can be wrong without any query noticing: a URL is a string,
  # every string inserts, and the picture is just missing. All 1,324 of them pointed at
  # `/img/<id>.jpg` for a while, and the dataset's files are named `<id>-<hash>.jpg`. Nothing
  # caught it because nothing had ever followed one. This does.
  EX=$(call "$CLIENT_JAR" GET '/api/exercises?limit=1')
  EX_IMG=$(field "$EX" "d.exercises[0].image_url")
  EX_GIF=$(field "$EX" "d.exercises[0].animation_url")
  for U in "$EX_IMG" "$EX_GIF"; do
    # Only a path served by this origin is ours to check — a deployment pointed at a CDN is
    # not something a smoke test of this instance should be reaching out to.
    case "$U" in
      /*) ART=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$U")
          [ "$ART" = "200" ] || { echo "FAIL: exercise media $U returned $ART"; exit 1; } ;;
      *)  step "  $U is off-origin - not this instance's to serve" ;;
    esac
  done

  step "the site's own pictures are under /assets/, out of the media volume's way"
  # Not a cosmetic path. The exercise media volume is mounted at /img, so the site keeping a
  # folder of that name at the document root would shadow 1,324 exercise images with five
  # screenshots — which nothing else here would notice.
  SHOT=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/assets/home.png")
  [ "$SHOT" = "200" ] || { echo "FAIL: /assets/home.png returned $SHOT — screenshots did not ship"; exit 1; }
else
  step "nothing serving / (got $SITE) — API-only run, skipping the site checks"
fi

echo "smoke: all good"
