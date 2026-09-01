# Built from the repo root so the workspace and its packages come along:
#   docker build -f apps/api/Dockerfile .
FROM node:22-alpine
WORKDIR /app

# Every workspace's manifest. npm resolves the workspace links from these, and `@gymyar/api`
# depends on six of them — a missing one is not a build error, it is an image that starts and
# dies on the first `import` at runtime. Which is exactly what `packages/sms` did when it was
# added to the workspace and not to this list: the container booted, `routes/phone.js` reached
# `@gymyar/sms`, and the only symptom was /api/health never answering.
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY apps/client/package.json apps/client/
COPY packages/domain/package.json packages/domain/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/mail/package.json packages/mail/
COPY packages/sms/package.json packages/sms/
COPY packages/ai/package.json packages/ai/
RUN npm install --omit=dev --workspace @gymyar/api --include-workspace-root \
 && npm cache clean --force

# The six packages the API actually imports. `apps/client` is not one of them — its manifest
# is above only so npm can see the whole workspace set, and its source has no business in a
# backend image.
COPY packages/domain/ packages/domain/
COPY packages/db/ packages/db/
COPY packages/storage/ packages/storage/
COPY packages/mail/ packages/mail/
COPY packages/sms/ packages/sms/
COPY packages/ai/ packages/ai/
COPY apps/api/ apps/api/

ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/app/apps/api/docker-entrypoint.sh"]
