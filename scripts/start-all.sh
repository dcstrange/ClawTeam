#!/usr/bin/env bash
#
# start-all.sh — One-click deployment for ClawTeam Platform
#
# Starts all services:
#   Docker:  PostgreSQL, Redis, API Server, Dashboard
#   Host:    ClawTeam Gateway (needs openclaw CLI access)
#
# Usage:
#   bash scripts/start-all.sh          # Start everything
#   bash scripts/start-all.sh --stop   # Stop everything
#   bash scripts/start-all.sh --status # Check status
#
# Access:
#   Dashboard:  http://localhost:8080
#   API:        http://localhost:3000
#   Router API: http://localhost:3100
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_FILE="$PROJECT_DIR/.gateway.pid"
LOG_DIR="$PROJECT_DIR/logs"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log()   { echo -e "${CYAN}[clawteam]${NC} $*"; }
ok()    { echo -e "${GREEN}[  OK  ]${NC} $*"; }
warn()  { echo -e "${YELLOW}[ WARN ]${NC} $*"; }
fail()  { echo -e "${RED}[FAILED]${NC} $*"; }

# ─── Stop ───────────────────────────────────────────────────────────────

stop_all() {
  log "Stopping ClawTeam Platform..."

  # Stop Gateway
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" 2>/dev/null && ok "Gateway stopped (PID $PID)"
    else
      warn "Gateway not running (stale PID file)"
    fi
    rm -f "$PID_FILE"
  else
    warn "No Gateway PID file found"
  fi

  # Stop Docker services
  cd "$PROJECT_DIR"
  docker compose --profile production down 2>/dev/null && ok "Docker services stopped" || warn "Docker services not running"

  log "All services stopped."
}

# ─── Status ─────────────────────────────────────────────────────────────

show_status() {
  echo ""
  echo -e "${BOLD}ClawTeam Platform Status${NC}"
  echo "════════════════════════════════════════"

  # Docker services
  for svc in postgres redis api dashboard; do
    local container="clawteam-$svc"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
      local status=$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "running")
      ok "$svc ($container) — $status"
    else
      fail "$svc ($container) — not running"
    fi
  done

  # Gateway
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "gateway (PID $(cat "$PID_FILE")) — running"
  else
    fail "gateway — not running"
  fi

  # Connectivity
  echo ""
  echo -e "${BOLD}Endpoints${NC}"
  echo "────────────────────────────────────────"
  for url in "http://localhost:3000/health" "http://localhost:3100/status" "http://localhost:8080/health"; do
    if curl -sf "$url" > /dev/null 2>&1; then
      ok "$url"
    else
      fail "$url"
    fi
  done
  echo ""
}

# ─── Start ──────────────────────────────────────────────────────────────

start_all() {
  log "Starting ClawTeam Platform..."
  echo ""

  cd "$PROJECT_DIR"

  # 1. Prerequisites
  command -v docker >/dev/null 2>&1 || { fail "Docker is required but not installed."; exit 1; }
  command -v node >/dev/null 2>&1   || { fail "Node.js is required but not installed."; exit 1; }
  command -v npx >/dev/null 2>&1    || { fail "npx is required but not installed."; exit 1; }

  # 2. Install dependencies if needed
  if [ ! -d "node_modules" ]; then
    log "Installing dependencies..."
    npm install
  fi

  # 3. Start Docker services (postgres, redis, api, dashboard)
  log "Starting Docker services (postgres, redis, api, dashboard)..."
  docker compose --profile production up -d --build 2>&1 | while IFS= read -r line; do
    echo "  $line"
  done
  echo ""

  # 4. Wait for API health check
  log "Waiting for API server to be ready..."
  local retries=0
  local max_retries=30
  while [ $retries -lt $max_retries ]; do
    if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
      ok "API server is healthy"
      break
    fi
    retries=$((retries + 1))
    sleep 2
  done
  if [ $retries -eq $max_retries ]; then
    warn "API server health check timed out (may still be starting)"
  fi

  # 5. Run database migrations if needed
  if command -v psql >/dev/null 2>&1; then
    local pg_password="${POSTGRES_PASSWORD:-}"
    if [ -z "$pg_password" ] && [ -f "$PROJECT_DIR/.env" ]; then
      pg_password=$(grep -E '^POSTGRES_PASSWORD=' "$PROJECT_DIR/.env" | tail -n 1 | cut -d '=' -f2- || true)
      pg_password="${pg_password#\"}"
      pg_password="${pg_password%\"}"
      pg_password="${pg_password#\'}"
      pg_password="${pg_password%\'}"
    fi
    pg_password="${pg_password:-changeme}"

    local table_count=$(PGPASSWORD="$pg_password" psql -h localhost -U clawteam -d clawteam -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo "0")
    if [ "$table_count" -lt 5 ] 2>/dev/null; then
      log "Running database migrations..."
      if [ -f "$PROJECT_DIR/DATABASE_SCHEMA.sql" ]; then
        PGPASSWORD="$pg_password" psql -h localhost -U clawteam -d clawteam -f "$PROJECT_DIR/DATABASE_SCHEMA.sql" > /dev/null 2>&1 && ok "Database schema applied" || warn "Database schema may already exist"
      fi
    else
      ok "Database already has $table_count tables"
    fi
  fi

  # 6. Start Gateway (host process)
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    ok "Gateway already running (PID $(cat "$PID_FILE"))"
  else
    log "Starting Gateway..."
    mkdir -p "$LOG_DIR"

    # Check config exists
    if [ ! -f "$HOME/.clawteam/config.yaml" ]; then
      warn "~/.clawteam/config.yaml not found — Gateway may fail to start"
      warn "Create it with at minimum: api.key and gateway.enabled: true"
    fi

    # Start gateway with API enabled
    GATEWAY_ENABLED=true \
    GATEWAY_PORT=3100 \
    CLAWTEAM_API_URL=http://localhost:3000 \
      npx tsx packages/clawteam-gateway/src/index.ts \
      >> "$LOG_DIR/gateway.log" 2>&1 &

    echo $! > "$PID_FILE"
    sleep 2

    if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      ok "Gateway started (PID $(cat "$PID_FILE"), log: logs/gateway.log)"
    else
      fail "Gateway failed to start — check logs/gateway.log"
      rm -f "$PID_FILE"
    fi
  fi

  # 7. Summary
  echo ""
  echo -e "${BOLD}════════════════════════════════════════${NC}"
  echo -e "${GREEN}${BOLD}  ClawTeam Platform is running!${NC}"
  echo -e "${BOLD}════════════════════════════════════════${NC}"
  echo ""
  echo -e "  ${BOLD}Dashboard${NC}   http://localhost:8080"
  echo -e "  ${BOLD}API${NC}         http://localhost:3000"
  echo -e "  ${BOLD}Router API${NC}  http://localhost:3100"
  echo ""
  echo -e "  ${BOLD}Stop:${NC}       bash scripts/start-all.sh --stop"
  echo -e "  ${BOLD}Status:${NC}     bash scripts/start-all.sh --status"
  echo -e "  ${BOLD}Gateway log:${NC} tail -f logs/gateway.log"
  echo ""
}

# ─── Main ───────────────────────────────────────────────────────────────

case "${1:-}" in
  --stop|-s)
    stop_all
    ;;
  --status|-st)
    show_status
    ;;
  *)
    start_all
    ;;
esac
