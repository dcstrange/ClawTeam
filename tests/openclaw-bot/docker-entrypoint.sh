#!/bin/bash
set -e

OPENCLAW_CONFIG_TEMPLATE="${OPENCLAW_CONFIG_TEMPLATE:-/openclaw-config-template}"
OPENCLAW_STATE_DIR="${OPENCLAW_HOME:-/home/node/.openclaw}"

# ─── 1. Copy config template to writable state dir ──────────
if [ ! -f "$OPENCLAW_CONFIG_TEMPLATE/openclaw.json" ]; then
  echo "[entrypoint] ERROR: openclaw.json not found at $OPENCLAW_CONFIG_TEMPLATE/"
  echo "[entrypoint] Mount a pre-configured config directory to $OPENCLAW_CONFIG_TEMPLATE (read-only)."
  echo "[entrypoint] To create one:"
  echo "  docker run -it --rm -v <host-path>:/home/node/.openclaw ghcr.io/openclaw/openclaw:latest node openclaw.mjs onboard"
  exit 1
fi

echo "[entrypoint] Copying config template to $OPENCLAW_STATE_DIR..."
mkdir -p "$OPENCLAW_STATE_DIR"
cp -a "$OPENCLAW_CONFIG_TEMPLATE/." "$OPENCLAW_STATE_DIR/"

# ─── 2. Install ClawTeam skills and plugin ──────────────────
SKILLS_DIR="$OPENCLAW_STATE_DIR/skills"
EXTENSIONS_DIR="$OPENCLAW_STATE_DIR/extensions"

# Core skill
if [ -f /clawteam-assets/openclaw-skill/SKILL.md ]; then
  mkdir -p "$SKILLS_DIR/clawteam"
  cp /clawteam-assets/openclaw-skill/SKILL.md "$SKILLS_DIR/clawteam/SKILL.md"
  if [ -d /clawteam-assets/openclaw-skill/references ]; then
    cp -r /clawteam-assets/openclaw-skill/references "$SKILLS_DIR/clawteam/"
  fi
  echo "[entrypoint] Installed clawteam skill"
fi

# Files skill
if [ -f /clawteam-assets/openclaw-files-skill/SKILL.md ]; then
  mkdir -p "$SKILLS_DIR/clawteam-files"
  cp /clawteam-assets/openclaw-files-skill/SKILL.md "$SKILLS_DIR/clawteam-files/SKILL.md"
  echo "[entrypoint] Installed clawteam-files skill"
fi

# Plugin
if [ -f /clawteam-assets/openclaw-plugin/openclaw.plugin.json ]; then
  mkdir -p "$EXTENSIONS_DIR/clawteam-auto-tracker"
  cp /clawteam-assets/openclaw-plugin/index.ts "$EXTENSIONS_DIR/clawteam-auto-tracker/"
  cp /clawteam-assets/openclaw-plugin/openclaw.plugin.json "$EXTENSIONS_DIR/clawteam-auto-tracker/"
  cp /clawteam-assets/openclaw-plugin/package.json "$EXTENSIONS_DIR/clawteam-auto-tracker/"
  for f in /clawteam-assets/openclaw-plugin/task_system_prompt_*.md; do
    [ -f "$f" ] && cp "$f" "$EXTENSIONS_DIR/clawteam-auto-tracker/"
  done
  echo "[entrypoint] Installed clawteam-auto-tracker plugin"
fi

# ─── 3. Start OpenClaw Gateway (background) ────────────────
OPENCLAW_GW_PORT="${OPENCLAW_GATEWAY_PORT:-18789}"

echo "[entrypoint] Starting OpenClaw Gateway on port $OPENCLAW_GW_PORT..."
node /app/openclaw.mjs gateway \
  --bind "${OPENCLAW_GATEWAY_BIND:-loopback}" \
  --port "$OPENCLAW_GW_PORT" &

OPENCLAW_PID=$!

# ─── 4. Wait for OpenClaw Gateway health ───────────────────
echo "[entrypoint] Waiting for OpenClaw Gateway..."
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$OPENCLAW_GW_PORT/healthz" > /dev/null 2>&1; then
    echo "[entrypoint] OpenClaw Gateway is ready (PID $OPENCLAW_PID)"
    break
  fi
  if ! kill -0 "$OPENCLAW_PID" 2>/dev/null; then
    echo "[entrypoint] ERROR: OpenClaw Gateway exited unexpectedly"
    exit 1
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:$OPENCLAW_GW_PORT/healthz" > /dev/null 2>&1; then
  echo "[entrypoint] ERROR: OpenClaw Gateway failed to start within 30s"
  exit 1
fi

# ─── 5. Start ClawTeam Gateway (foreground) ─────────────────
echo "[entrypoint] Starting ClawTeam Gateway on port ${GATEWAY_PORT:-3100}..."
cd /clawteam
exec npx tsx packages/clawteam-gateway/src/index.ts
