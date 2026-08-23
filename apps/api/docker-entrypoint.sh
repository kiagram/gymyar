#!/bin/sh
# Migrate and seed before serving. Both are idempotent and recorded, so every boot after the
# first is a no-op — which is what makes `docker compose up` the only command anyone needs.
set -e
if [ -n "$SEED_DEMO" ]; then
  echo "→ migrate, seed library, seed demo accounts"
  node packages/db/src/cli.js demo
else
  echo "→ migrate and seed exercise library"
  node packages/db/src/cli.js seed
fi
exec node apps/api/src/server.js
