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
  '{"changes":{"routines":[{"id":"smoke-r1","name":"My own","exercises":[{"id":"0025","sets":3,"reps":5}]}]}}' >/dev/null

step "coach invites, client accepts"
CODE=$(field "$(call "$COACH_JAR" POST /api/coach/invites '{"scopes":["programmes","workouts"]}')" "d.invite.code")
call "$CLIENT_JAR" POST "/api/invites/$CODE/accept" '{"scopes":["programmes"]}' >/dev/null

step "coach sees the client"
field "$(call "$COACH_JAR" GET /api/coach/clients)" "d.clients.length" >/dev/null

step "coach proposes; client's routine must not change"
call "$COACH_JAR" POST "/api/coach/clients/$CLIENT_ID/propose" \
  '{"routineId":"smoke-r1","payload":{"name":"Coach version","exercises":[{"id":"0025","sets":5,"reps":5}]},"note":"five across"}' >/dev/null
NAME=$(field "$(call "$CLIENT_JAR" GET /api/sync/all)" "d.changes.routines[0].name")
[ "$NAME" = "My own" ] || { echo "FAIL: proposal overwrote the client ($NAME)"; exit 1; }

step "client accepts; now it changes"
PID=$(field "$(call "$CLIENT_JAR" GET /api/proposals)" "d.proposals[0].id")
call "$CLIENT_JAR" POST "/api/proposals/$PID/accept" '{}' >/dev/null
NAME=$(field "$(call "$CLIENT_JAR" GET /api/sync/all)" "d.changes.routines[0].name")
[ "$NAME" = "Coach version" ] || { echo "FAIL: accept did not apply ($NAME)"; exit 1; }

step "scope is honoured"
BW=$(call "$COACH_JAR" GET "/api/coach/clients/$CLIENT_ID" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.bodyweight===undefined?'hidden':'LEAKED')")
[ "$BW" = "hidden" ] || { echo "FAIL: body weight visible without the scope"; exit 1; }

echo "smoke: all good"
