# Built from the repo root so the workspace and @gymbuddy/domain come along:
#   docker build -f apps/api/Dockerfile .
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/api/package.json apps/api/
COPY packages/domain/package.json packages/domain/
RUN npm install --omit=dev -w @gymbuddy/api && npm cache clean --force
COPY packages/domain/ packages/domain/
COPY apps/api/ apps/api/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/api/server.js"]
