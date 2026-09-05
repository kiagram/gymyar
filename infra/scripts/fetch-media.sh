#!/usr/bin/env bash
# Manually download the exercise images (JPG) and animations (GIF) into ./media.
# You normally DON'T need this — `docker compose up` fetches them automatically.
# Source: hasaneyldrm/exercises-dataset (CC).
set -euo pipefail
# Two levels up, not one: this file is in infra/scripts, so `..` is `infra` and the 139 MB
# landed in infra/media — a path nothing reads. docker-compose.yml mounts ./media/img from the
# repo root and vite proxies /img to a server rooted there, so the download appeared to work,
# the placeholders stayed at zero bytes, and every exercise picture rendered broken.
cd "$(dirname "$0")/../.."
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git clone --depth 1 https://github.com/hasaneyldrm/exercises-dataset "$tmp"
mkdir -p media/img media/gif
cp "$tmp"/images/*.jpg media/img/
cp "$tmp"/videos/*.gif media/gif/
# Counted by weight rather than by name. `ls | wc -l` was the reason the bug above survived:
# media/img is pre-populated with 1,324 zero-byte placeholders by media-placeholders.mjs, so
# the count came out at 1,324 whether or not a single byte had been copied into it.
imgs=$(find media/img -name '*.jpg' -size +0 | wc -l)
gifs=$(find media/gif -name '*.gif' -size +0 | wc -l)
if [ "$imgs" -eq 0 ] || [ "$gifs" -eq 0 ]; then
  echo "✗ nothing was copied — media/img and media/gif are still placeholders" >&2
  exit 1
fi
echo "✓ $imgs images, $gifs GIFs"
