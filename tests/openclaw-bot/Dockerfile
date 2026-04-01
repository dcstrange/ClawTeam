# ClawTeam Gateway + OpenClaw — Combined Docker Image
#
# Layers the ClawTeam Gateway on top of the official OpenClaw image.
# The Gateway communicates with OpenClaw via CLI (child_process.spawn),
# so both must share the same filesystem and process namespace.
#
# Single-stage build using OpenClaw's Node 24 runtime to compile
# and run the Gateway (avoids pulling a separate node base image).
#
# Prerequisites:
#   docker pull ghcr.io/openclaw/openclaw:latest
#
# Usage:
#   Built via docker-compose-test.yml, not standalone.

FROM ghcr.io/openclaw/openclaw:latest

USER root

# curl is already included in the OpenClaw image

# ─── Build Gateway ──────────────────────────────────────────
WORKDIR /clawteam

# Copy root workspace files
COPY package*.json ./

# Copy gateway package and shared types
COPY packages/clawteam-gateway/ packages/clawteam-gateway/
COPY packages/shared/ packages/shared/

# Install deps + tsx (tsconfig has noEmit:true, so we run TS directly like the API)
RUN npm install && npm install tsx

# ─── Copy skills and plugin ────────────────────────────────
COPY packages/openclaw-skill/ /clawteam-assets/openclaw-skill/
COPY packages/openclaw-files-skill/ /clawteam-assets/openclaw-files-skill/
COPY packages/openclaw-plugin/ /clawteam-assets/openclaw-plugin/

# ─── Entrypoint ────────────────────────────────────────────
COPY tests/openclaw-bot/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Ensure node user owns the clawteam directories
RUN chown -R node:node /clawteam /clawteam-assets

# Environment defaults
ENV OPENCLAW_BIN=openclaw
ENV OPENCLAW_HOME=/home/node/.openclaw
ENV SESSION_PROVIDER=openclaw
ENV OPENCLAW_MODE=cli
ENV GATEWAY_ENABLED=true
ENV GATEWAY_PORT=3100

EXPOSE 3100

USER node

ENTRYPOINT ["/entrypoint.sh"]
