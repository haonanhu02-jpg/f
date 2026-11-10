ARG NODE_IMAGE=node:24.15.0-bookworm-slim

FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /app/frontend
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_fetch_retries=2 npm_config_fetch_timeout=60000 npm_config_fetch_retry_mintimeout=3000 npm_config_fetch_retry_maxtimeout=15000
COPY frontend/package.json frontend/package-lock.json ./
COPY deploy/docker/install-dependencies.mjs /tools/install-dependencies.mjs
RUN node /tools/install-dependencies.mjs frontend
COPY frontend/ ./
RUN npm run typecheck && npm run build:production

FROM ${NODE_IMAGE} AS backend-deps
WORKDIR /app/backend
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV npm_config_fetch_retries=2 npm_config_fetch_timeout=60000 npm_config_fetch_retry_mintimeout=3000 npm_config_fetch_retry_maxtimeout=15000
COPY backend/package.json backend/package-lock.json ./
COPY vendor/xlsx-0.20.3.tgz /vendor/xlsx-0.20.3.tgz
COPY deploy/docker/install-dependencies.mjs /tools/install-dependencies.mjs
RUN node /tools/install-dependencies.mjs backend

FROM ${NODE_IMAGE} AS runtime
ARG SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.title="Archive Ledger" org.opencontainers.image.revision=${SOURCE_COMMIT}
ENV NODE_ENV=production PORT=8080 ARCHIVE_HOST=0.0.0.0 ARCHIVE_DB_PATH=/data/archive.sqlite ARCHIVE_STATIC_DIR=/app/frontend/dist-production ARCHIVE_BACKUP_DIR=/backups
WORKDIR /app/backend
RUN mkdir -p /data /backups && chown node:node /data /backups
COPY --from=backend-deps --chown=node:node /app/backend/node_modules ./node_modules
COPY --chown=node:node backend/src ./src
COPY --chown=node:node backend/seed ./seed
COPY --chown=node:node backend/package.json backend/version.json ./
COPY --chown=node:node backend/scripts/maintenance.mjs ./scripts/maintenance.mjs
COPY --from=frontend-build --chown=node:node /app/frontend/dist-production /app/frontend/dist-production
USER node
EXPOSE 8080
CMD ["node", "src/server.mjs"]
