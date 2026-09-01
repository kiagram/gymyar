#!/usr/bin/env bash
# Background servers for one CI step, and the guarantee that they do not outlive it.
#
#   source infra/scripts/ci-server.sh
#   ci_start 3000 npm start -w @gymyar/api
#
# Every `run:` block in a workflow is its own shell, but a job is one machine. A server
# started with `&` is not cleaned up when the block that started it ends — the runner only
# reaps it at the end of the whole job, which it reports as "Terminate orphan process" long
# after anything could act on it.
#
# That is not tidiness. The smoke step and the browser step both start an API on :3000, and
# the smoke step's survived into the browser step, so the browser step's own API died on
# `EADDRINUSE` — a line npm prints from a background job, which fails nothing. `wait-on` then
# passed, because the *previous* step's server answered `/api/health`. The browser suite ran
# green against a server carrying the wrong `STORAGE_PATH`, which is the one thing that step
# sets its own directory for. A step that cannot start its server should fail, not inherit one.
#
# So this does two things, and the first matters more than the second: it refuses to start
# when the port is already taken, and it kills what it started when the step ends — including
# on failure, which is why the teardown is a trap rather than a line at the bottom.
#
# Deliberately sets no shell options: it is sourced into a step's own shell, and `set -u`
# leaking into somebody else's script is a worse bug than the one this fixes.

CI_SERVER_PIDS=()
CI_SERVER_PORTS=()

# Nothing may be listening here yet. If something is, say which process, because the answer
# is always "the step before this one" and the log should not make that a deduction.
ci_port_must_be_free() {
  local port=$1
  if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "ci-server: :$port was already in use before this step started." >&2
    echo "ci-server: a server from an earlier step outlived it. Start it with ci_start." >&2
    lsof -i "tcp:$port" -sTCP:LISTEN >&2 2>/dev/null || true
    return 1
  fi
  return 0
}

# `npm start` is three processes — npm, the `sh -c` it spawns, and node, which is the one
# holding the port. Killing the job's own pid orphans the other two, so walk down first.
ci_kill_tree() {
  local pid=$1 child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    ci_kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

ci_stop_servers() {
  local status=$? pid port
  for pid in ${CI_SERVER_PIDS[@]+"${CI_SERVER_PIDS[@]}"}; do
    ci_kill_tree "$pid"
  done
  # The tree walk is a race — a process that reparented between pgrep and kill is missed.
  # The port is the thing that actually has to be free for the next step, so check that
  # directly rather than trusting the walk.
  for port in ${CI_SERVER_PORTS[@]+"${CI_SERVER_PORTS[@]}"}; do
    for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
      kill -9 "$pid" 2>/dev/null || true
    done
  done
  return $status
}

ci_start() {
  local port=$1; shift
  ci_port_must_be_free "$port" || return 1
  "$@" &
  CI_SERVER_PIDS+=("$!")
  CI_SERVER_PORTS+=("$port")
  trap ci_stop_servers EXIT
  return 0
}
