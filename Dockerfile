# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only -------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- runtime: just node, node_modules and the app code ------------------------
FROM node:20-alpine
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION}
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY config ./config

# Files stay owned by root, so the app user cannot modify its own code.
# The base image ships a "node" user (uid 1000); the Kubernetes securityContext
# pins the same uid so runAsNonRoot can be verified.
USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "src/healthcheck.js"]

# Exec form: node is PID 1 and receives SIGTERM directly (no shell in between).
CMD ["node", "src/server.js"]
