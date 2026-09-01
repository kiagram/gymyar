# Multi-stage: build the React app, then serve it with nginx.
# Self-hosters never need Node locally — `docker compose up` builds everything.
#
# --platform=$BUILDPLATFORM pins the build stage to the host's native arch even when
# cross-building for other targets (e.g. amd64 host building an arm64 image). The build
# output (static JS/CSS/HTML) is arch-independent, so there's no reason to run it under
# QEMU — and QEMU-emulated npm installs are known to corrupt esbuild/rollup's platform-
# specific native binaries, which is what breaks `vite build` with unrelated-looking
# module-resolution errors.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

# Every workspace's manifest, not only the two this image builds. `npm ci` validates the
# lockfile against the whole workspace set and refuses when one is missing — and a refusal
# here is what used to fall through to `npm install`, which resolves the tree afresh and hits
# npm's optional-dependency bug (npm/cli#4828): the platform-specific rolldown binding for
# linux-musl is in the lockfile and is not installed, so `vite build` dies with "Cannot find
# native binding". The manifests are cheap and they change rarely, so this layer still caches.
COPY package.json package-lock.json* ./
COPY apps/client/package.json apps/client/
COPY apps/api/package.json apps/api/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/mail/package.json packages/mail/
COPY packages/sms/package.json packages/sms/
COPY packages/ai/package.json packages/ai/
# No `|| npm install` fallback. A lockfile that does not match the manifests is a bug to fix,
# not a condition to route around — routing around it is what produced a broken image that
# looked like a build failure in vite.
RUN npm ci

COPY packages/domain/ packages/domain/
COPY apps/client/ apps/client/
RUN npm run build -w @gymyar/client

FROM nginx:alpine
COPY infra/web/nginx.conf /etc/nginx/conf.d/default.conf

# The front door: the project site, at `/`. Hand-written HTML with no build step, which is
# why it is copied rather than built — see apps/site/README.md.
COPY apps/site/ /usr/share/nginx/html/

# The app itself, one level down at `/app/`. Built with `base: './'` and a HashRouter, so it
# does not know it moved; see the /app/ block in nginx.conf.
COPY --from=build /app/apps/client/dist /usr/share/nginx/html/app

# The site's images are not in apps/site — they are the same files the store listings and the
# README use, and a second copy in the tree is a second copy to forget to retake. `.gitignore`
# keeps them out of apps/site and `.dockerignore` lets exactly these two paths through.
#   assets/screenshots/{,fa/}*.png  →  /assets/*.png and /assets/fa/*.png
COPY assets/screenshots/ /usr/share/nginx/html/assets/
COPY assets/banner.png /usr/share/nginx/html/assets/banner.png

# Icons come from the client, so the browser tab on the site, the home-screen icon and the
# app's own icon are one file rather than three that drift.
COPY apps/client/public/icon-180.png apps/client/public/icon-512.png /usr/share/nginx/html/

# exercise media (img/gif) is mounted at runtime from the media volume
