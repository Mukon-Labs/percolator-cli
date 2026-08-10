# Oracle keeper — a small always-on worker (no HTTP service).
FROM node:22-slim

WORKDIR /app

# Install deps first for layer caching. Install from package.json (not `npm ci`)
# because the committed lockfile may lag the keeper's dependency tweaks.
COPY package.json ./
RUN npm install --no-audit --no-fund

# The keeper is a standalone tsx script (scripts/oracle-keeper-v16.ts) — no build step.
COPY . .

CMD ["npm", "start"]
