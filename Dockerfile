# Oracle keeper — a small always-on worker (no HTTP service).
FROM node:22-slim

ARG NINJA_RELEASE_SOURCE=local
ARG NINJA_RELEASE_ID=local
ENV NINJA_RELEASE_SOURCE=${NINJA_RELEASE_SOURCE}
ENV NINJA_RELEASE_ID=${NINJA_RELEASE_ID}

WORKDIR /app

# Install deps first for layer caching. Install from package.json (not `npm ci`)
# because the committed lockfile may lag the keeper's dependency tweaks.
COPY package.json ./
RUN npm install --no-audit --no-fund

# The keeper is a standalone tsx script — no build step.
COPY . .

# Keep Node as PID 1 so Fly stop/restart signals reach the keeper's cancellation
# handlers directly instead of waiting behind an npm child-process wrapper.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "scripts/oracle-keeper-v16.ts"]
