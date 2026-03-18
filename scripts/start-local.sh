#!/bin/bash
set -e

# ClawTeam 本地部署脚本（Dashboard + Gateway + Skill 安装）
# 在项目根目录执行
#
# 首次部署（分两步）：
#   1. bash scripts/start-local.sh --setup --ec2-ip <IP>
#      → 配置文件 + 安装 Skill + 同步 openclaw.json
#      → 然后启动 OpenClaw 输入"连接 ClawTeam"获取 API Key
#   2. bash scripts/start-local.sh --api-key <KEY>
#      → 写入 API Key 并启动所有服务
#
# 后续启动：
#   bash scripts/start-local.sh
#
# 可选参数：
#   --ec2-ip <IP>       设置 EC2 API Server IP
#   --api-key <KEY>     设置 API Key
#   --setup             只配置不启动（用于首次安装 Skill 后去 OpenClaw 注册）
#   --force-install     强制重装依赖（清除 node_modules 后重新安装）

# ── Helper: convert path for Node.js on MINGW/Git Bash ──
# MINGW64 uses /c/Users/... but Node.js needs C:\Users\... or C:/Users/...
to_native_path() {
  if command -v cygpath &>/dev/null; then
    cygpath -w "$1"
  else
    echo "$1"
  fi
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
CONFIG_DIR="$HOME/.clawteam"
CONFIG_FILE="$CONFIG_DIR/config.yaml"
VITE_CONFIG="$PROJECT_ROOT/packages/dashboard/vite.config.ts"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
SKILL_SRC="$PROJECT_ROOT/packages/openclaw-skill/SKILL.md"
SKILL_DIR="$HOME/.openclaw/skills/clawteam"
PLUGIN_SRC="$PROJECT_ROOT/packages/openclaw-plugin"
PLUGIN_DIR="$HOME/.openclaw/extensions/clawteam-auto-tracker"

# Parse arguments
EC2_IP=""
API_KEY=""
SETUP_ONLY=false
FORCE_INSTALL=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --ec2-ip) EC2_IP="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --setup) SETUP_ONLY=true; shift ;;
    --force-install) FORCE_INSTALL=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

cd "$PROJECT_ROOT"

# ── Helper: resolve API URL from config sources ──
# Priority: --ec2-ip arg > config.yaml > vite.config.ts > default
resolve_api_url() {
  if [ -n "$EC2_IP" ]; then
    echo "http://$EC2_IP:3000"
    return
  fi
  if [ -f "$CONFIG_FILE" ]; then
    local yaml_url
    yaml_url=$(grep -E '^\s+url:' "$CONFIG_FILE" | head -1 | sed 's/.*url:\s*//' | tr -d ' ')
    if [ -n "$yaml_url" ]; then
      echo "$yaml_url"
      return
    fi
  fi
  local vite_url
  vite_url=$(grep -oE 'http://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:3000' "$VITE_CONFIG" 2>/dev/null | head -1)
  if [ -n "$vite_url" ]; then
    echo "$vite_url"
    return
  fi
  echo "http://localhost:3000"
}

# ── Step 1: Check prerequisites ──
echo "==> Checking prerequisites..."

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "    ERROR: $1 not found. Please install it first."
    exit 1
  fi
}

check_cmd node
check_cmd npm
check_cmd openclaw

NODE_MAJOR=$(node -v | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "    ERROR: Node.js 20+ required, found $(node -v)"
  exit 1
fi
echo "    Node $(node -v), npm $(npm -v), openclaw ✓"

# ── Step 2: Install dependencies if needed ──
if [ "$FORCE_INSTALL" = true ]; then
  echo "==> Force reinstalling dependencies..."
  rm -rf node_modules
  npm install
elif [ ! -d "node_modules" ]; then
  echo "==> Installing dependencies..."
  npm install
else
  echo "==> Dependencies already installed."
fi

# ── Step 3: Write/update config.yaml ──
API_URL=$(resolve_api_url)

if [ -n "$EC2_IP" ] || [ -n "$API_KEY" ]; then
  mkdir -p "$CONFIG_DIR"

  if [ -n "$API_KEY" ]; then
    # Override env var so Gateway subprocess uses the new key
    export CLAWTEAM_API_KEY="$API_KEY"

    if [ -f "$CONFIG_FILE" ]; then
      # Config exists — update url and key only, preserve everything else (e.g. botId)
      echo "==> Updating API Key in $CONFIG_FILE (preserving existing settings)"
      sed -i.bak "s|^\(\s*\)key:.*|\\1key: $API_KEY|" "$CONFIG_FILE"
      sed -i.bak "s|^\(\s*\)url:.*|\\1url: $API_URL|" "$CONFIG_FILE"
      rm -f "$CONFIG_FILE.bak"
      echo "    Config updated (API: $API_URL)"
    else
      # No config yet — write full template
      echo "==> Writing config to $CONFIG_FILE (with API Key)"
      cat > "$CONFIG_FILE" << EOF
# ========================================
# ClawTeam 统一配置文件
# 被 local-client 和 clawteam-gateway 共同读取
# ========================================

# --- 共用 ---
api:
  url: $API_URL
  key: $API_KEY
  botId:   # 注册 bot 后自动填充

# --- clawteam-gateway ---
gateway:
  url: http://localhost:3100
  enabled: true
  port: 3100
  proxyEnabled: true

openclaw:
  mode: cli
  bin: openclaw
  home: ~/.openclaw
  mainAgentId: main

polling:
  intervalMs: 15000
  limit: 10

logging:
  level: info

heartbeat:
  enabled: true
  intervalMs: 30000

recovery:
  enabled: true
  intervalMs: 30000
  stalenessThresholdMs: 60000
  maxAttempts: 3

# --- local-client ---
preferences:
  refreshInterval: 5
  messageCount: 20
  openclawHome: ~/.openclaw
EOF
      echo "    Config written (API: $API_URL)"
    fi

  elif [ -n "$EC2_IP" ]; then
    # Partial config without API Key (setup mode)
    if [ -f "$CONFIG_FILE" ]; then
      # Update URL only, preserve existing key
      sed -i.bak "s|url:.*|url: $API_URL|" "$CONFIG_FILE"
      rm -f "$CONFIG_FILE.bak"
      echo "==> Updated API URL in $CONFIG_FILE → $API_URL"
    else
      echo "==> Writing config to $CONFIG_FILE (without API Key — will add after registration)"
      cat > "$CONFIG_FILE" << EOF
# ========================================
# ClawTeam 统一配置文件
# 被 local-client 和 clawteam-gateway 共同读取
# ========================================

# --- 共用 ---
api:
  url: $API_URL
  key: PLACEHOLDER_RUN_SETUP_FIRST

# --- clawteam-gateway ---
gateway:
  url: http://localhost:3100
  enabled: true
  port: 3100
  proxyEnabled: true

openclaw:
  mode: cli
  bin: openclaw
  home: ~/.openclaw
  mainAgentId: main

polling:
  intervalMs: 15000
  limit: 10

logging:
  level: info

heartbeat:
  enabled: true
  intervalMs: 30000

recovery:
  enabled: true
  intervalMs: 30000
  stalenessThresholdMs: 60000
  maxAttempts: 3

# --- local-client ---
preferences:
  refreshInterval: 5
  messageCount: 20
  openclawHome: ~/.openclaw
EOF
      echo "    Config written (API: $API_URL, Key: pending)"
    fi
  fi
fi

# ── Step 4: Install ClawTeam Skill + auto-configure OpenClaw ──
# 4a. Copy SKILL.md
if [ -f "$SKILL_SRC" ]; then
  if [ ! -f "$SKILL_DIR/SKILL.md" ] || ! diff -q "$SKILL_SRC" "$SKILL_DIR/SKILL.md" &>/dev/null; then
    echo "==> Installing ClawTeam Skill to OpenClaw..."
    mkdir -p "$SKILL_DIR"
    cp "$SKILL_SRC" "$SKILL_DIR/SKILL.md"
    echo "    Copied SKILL.md → $SKILL_DIR/"
  else
    echo "==> ClawTeam Skill already up to date."
  fi
else
  echo "==> WARNING: SKILL.md not found at $SKILL_SRC, skipping skill install."
fi

# 4b. Install OpenClaw Plugin (clawteam-auto-tracker) via official CLI
if [ -d "$PLUGIN_SRC" ]; then
  # Check if already installed with correct provenance
  PLUGIN_INSTALLED=false
  if command -v node &>/dev/null && [ -f "$OPENCLAW_CONFIG" ]; then
    PLUGIN_INSTALLED=$(node -e "
      const fs = require('fs');
      try {
        const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_CONFIG', 'utf8'));
        const rec = cfg.plugins?.installs?.['clawteam-auto-tracker'];
        console.log(rec ? 'true' : 'false');
      } catch { console.log('false'); }
    ")
  fi

  if [ "$PLUGIN_INSTALLED" = "true" ]; then
    echo "==> ClawTeam Auto Tracker Plugin already installed (with provenance)."
  else
    echo "==> Installing ClawTeam Auto Tracker Plugin via openclaw CLI..."
    openclaw plugins install --link "$PLUGIN_SRC" 2>&1 || {
      echo "    WARNING: openclaw plugins install failed, falling back to manual copy"
      mkdir -p "$PLUGIN_DIR"
      cp "$PLUGIN_SRC/index.ts" "$PLUGIN_DIR/index.ts"
      cp "$PLUGIN_SRC/openclaw.plugin.json" "$PLUGIN_DIR/openclaw.plugin.json"
      cp "$PLUGIN_SRC/task_system_prompt_executor.md" "$PLUGIN_DIR/task_system_prompt_executor.md"
      cp "$PLUGIN_SRC/task_system_prompt_sender.md" "$PLUGIN_DIR/task_system_prompt_sender.md"
    }
    echo "    Plugin installed → clawteam-auto-tracker"
  fi
else
  echo "==> WARNING: Plugin source not found at $PLUGIN_SRC, skipping plugin install."
fi

# 4c. Auto-configure openclaw.json from config.yaml
API_URL=$(resolve_api_url)
# Read API Key from config.yaml or env
API_KEY_VAL="${CLAWTEAM_API_KEY:-}"
if [ -z "$API_KEY_VAL" ] && [ -f "$CONFIG_FILE" ]; then
  API_KEY_VAL=$(grep -E '^\s+key:' "$CONFIG_FILE" | head -1 | sed 's/.*key:\s*//' | tr -d ' ')
fi
NEEDS_UPDATE=false

if [ ! -f "$OPENCLAW_CONFIG" ]; then
  NEEDS_UPDATE=true
elif ! grep -q '"clawteam"' "$OPENCLAW_CONFIG" 2>/dev/null; then
  NEEDS_UPDATE=true
else
  CURRENT_URL=$(grep -oE 'http://[^"]+' "$OPENCLAW_CONFIG" | grep -E ':[0-9]+$' | head -1)
  if [ "$CURRENT_URL" != "$API_URL" ]; then
    NEEDS_UPDATE=true
  fi
  # Also update if API Key is set but value differs in openclaw.json
  if [ -n "$API_KEY_VAL" ]; then
    CURRENT_KEY=$(sed -n 's/.*"CLAWTEAM_API_KEY"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$OPENCLAW_CONFIG" 2>/dev/null)
    if [ "$CURRENT_KEY" != "$API_KEY_VAL" ]; then
      NEEDS_UPDATE=true
    fi
  fi
fi

if [ "$NEEDS_UPDATE" = true ]; then
  echo "==> Configuring OpenClaw (CLAWTEAM_API_URL=$API_URL)..."
  mkdir -p "$(dirname "$OPENCLAW_CONFIG")"

  if [ -f "$OPENCLAW_CONFIG" ] && command -v node &>/dev/null; then
    # Pass path via env var to avoid shell escaping issues on Windows (Git Bash)
    OPENCLAW_CONFIG_PATH="$OPENCLAW_CONFIG" CLAWTEAM_API_URL_VAL="$API_URL" CLAWTEAM_API_KEY_VAL="$API_KEY_VAL" node -e "
      const fs = require('fs');
      const path = require('path');
      const p = path.resolve(process.env.OPENCLAW_CONFIG_PATH);
      const apiUrl = process.env.CLAWTEAM_API_URL_VAL;
      const apiKey = process.env.CLAWTEAM_API_KEY_VAL;
      let cfg = {};
      try { cfg = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
      if (!cfg.skills) cfg.skills = {};
      if (!cfg.skills.entries) cfg.skills.entries = {};
      const env = { CLAWTEAM_API_URL: apiUrl };
      if (apiKey) env.CLAWTEAM_API_KEY = apiKey;
      cfg.skills.entries.clawteam = { enabled: true, env };
      if (!cfg.plugins) cfg.plugins = {};
      if (!cfg.plugins.allow) cfg.plugins.allow = [];
      if (!cfg.plugins.allow.includes('clawteam-auto-tracker')) cfg.plugins.allow.push('clawteam-auto-tracker');
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
    "
    echo "    Merged clawteam into existing $OPENCLAW_CONFIG"
  else
    # Build env JSON with optional API Key
    if [ -n "$API_KEY_VAL" ]; then
      ENV_JSON="\"CLAWTEAM_API_URL\": \"$API_URL\", \"CLAWTEAM_API_KEY\": \"$API_KEY_VAL\""
    else
      ENV_JSON="\"CLAWTEAM_API_URL\": \"$API_URL\""
    fi
    cat > "$OPENCLAW_CONFIG" << EOF
{
  "skills": {
    "entries": {
      "clawteam": {
        "enabled": true,
        "env": {
          $ENV_JSON
        }
      }
    }
  },
  "plugins": {
    "allow": ["clawteam-auto-tracker"]
  }
}
EOF
    echo "    Created $OPENCLAW_CONFIG"
  fi
else
  echo "==> OpenClaw config already up to date."
fi

# ── Step 5: Update EC2 IP in vite.config.ts ──
if [ -n "$EC2_IP" ]; then
  echo "==> Updating vite.config.ts with EC2 IP: $EC2_IP"
  sed -i.bak -E "s|http://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:3000|http://$EC2_IP:3000|g" "$VITE_CONFIG"
  sed -i.bak -E "s|ws://[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+:3000|ws://$EC2_IP:3000|g" "$VITE_CONFIG"
  rm -f "$VITE_CONFIG.bak"
  echo "    Updated proxy targets to $EC2_IP"
fi

# ── Setup mode: stop here ──
if [ "$SETUP_ONLY" = true ]; then
  echo ""
  echo "==> Setup complete!"
  echo ""
  echo "    ~/.clawteam/config.yaml    → Gateway config (API URL set)"
  echo "    ~/.openclaw/openclaw.json  → OpenClaw skill config (auto-synced)"
  echo "    ~/.openclaw/skills/clawteam/SKILL.md → Skill definition (installed)"
  echo "    ~/.openclaw/extensions/clawteam-auto-tracker/ → Plugin (installed)"
  echo ""
  echo "==> Next steps:"
  echo "    1. Start OpenClaw and type: 连接 ClawTeam，我的名字是 <你的名字>，我的能力是 <你的能力>"
  echo "    2. Save the returned API Key"
  echo "    3. Run: bash scripts/start-local.sh --api-key <YOUR_API_KEY>"
  exit 0
fi

# ── Step 6: Validate config ──
echo "==> Validating configuration..."

if [ ! -f "$CONFIG_FILE" ] && [ -z "$CLAWTEAM_API_KEY" ]; then
  echo "    ERROR: No config found."
  echo "    Run: bash scripts/start-local.sh --setup --ec2-ip <IP>"
  echo "    See: doc/-local-deployment.md"
  exit 1
fi

# Check API Key is real (not placeholder)
if [ -f "$CONFIG_FILE" ] && grep -q "PLACEHOLDER_RUN_SETUP_FIRST" "$CONFIG_FILE"; then
  echo "    ERROR: API Key not set yet."
  echo "    1. Start OpenClaw and type: 连接 ClawTeam"
  echo "    2. Run: bash scripts/start-local.sh --api-key <YOUR_API_KEY>"
  exit 1
fi

# Check GATEWAY_ENABLED
if [ -z "$GATEWAY_ENABLED" ]; then
  if [ -f "$CONFIG_FILE" ] && grep -q "enabled: true" "$CONFIG_FILE"; then
    echo "    Gateway API enabled via config.yaml"
  else
    export GATEWAY_ENABLED=true
    echo "    Gateway API enabled via env var"
  fi
fi

echo "    Configuration OK"
echo ""
echo "    ~/.clawteam/config.yaml    → Gateway config (API URL + Key)"
echo "    ~/.openclaw/openclaw.json  → OpenClaw skill config (auto-synced)"
echo "    ~/.openclaw/skills/clawteam/SKILL.md → Skill definition (auto-synced)"
echo "    ~/.openclaw/extensions/clawteam-auto-tracker/ → Plugin (auto-synced)"

# ── Step 7: Clean up old processes ──
echo "==> Checking for existing processes..."
GATEWAY_PID=$(lsof -ti:3100 2>/dev/null || true)
DASHBOARD_PID=$(lsof -ti:5173 2>/dev/null || true)

if [ -n "$GATEWAY_PID" ]; then
  echo "    Found Gateway process on port 3100 (PID: $GATEWAY_PID), stopping..."
  kill -9 $GATEWAY_PID 2>/dev/null || true
  sleep 1
fi

if [ -n "$DASHBOARD_PID" ]; then
  echo "    Found Dashboard process on port 5173 (PID: $DASHBOARD_PID), stopping..."
  kill -9 $DASHBOARD_PID 2>/dev/null || true
  sleep 1
fi

# ── Step 8: Start services ──
echo ""
echo "==> Starting Dashboard (:5173) + Gateway (:3100)..."
echo "    Press Ctrl+C to stop both services."
echo ""

npx concurrently \
  --names "router,dashboard" \
  --prefix-colors "cyan,magenta" \
  --kill-others \
  "npm run dev --workspace=@clawteam/gateway" \
  "npm run dev --workspace=@clawteam/dashboard -- --host"
