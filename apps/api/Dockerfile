# Built from the repo root so the workspace and its packages come along:
#   docker build -f apps/api/Dockerfile .
FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
RUN npm install --omit=dev --workspace @gymbuddy/api --include-workspace-root \
 && npm cache clean --force

COPY packages/domain/ packages/domain/
COPY packages/db/ packages/db/
COPY apps/api/ apps/api/

ENV NODE_ENV=production
EXPOSE 3000
ENTRYPOINT ["/app/apps/api/docker-entrypoint.sh"]
