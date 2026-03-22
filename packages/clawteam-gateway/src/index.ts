/**
 * ClawTeam Gateway Entry Point
 *
 * Wires all components together, starts the polling loop,
 * and handles graceful shutdown on SIGINT/SIGTERM.
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config as loadEnv } from 'dotenv';
import { loadConfig } from './config.js';
import { createLogger } from './utils/logger.js';
import { printStartupBanner } from './utils/startup-banner.js';
import { ClawTeamApiClient } from './clients/clawteam-api.js';
import { OpenClawSessionClient, type IOpenClawSessionClient } from './clients/openclaw-session.js';
import { OpenClawSessionCliClient } from './clients/openclaw-session-cli.js';
import { SessionTracker } from './routing/session-tracker.js';
import { RoutedTasksTracker } from './routing/routed-tasks.js';
import { TaskRouter } from './routing/router.js';
import { TaskPollingLoop } from './polling/task-poller.js';
import { SessionStatusResolver } from './monitoring/session-status-resolver.js';
import { HeartbeatLoop } from './monitoring/heartbeat-loop.js';
import { StaleTaskRecoveryLoop } from './recovery/stale-task-recovery-loop.js';
import { RouterApiServer } from './server/router-api.js';
import type { GatewayConfig } from './config.js';
import type { Logger } from 'pino';

// Load monorepo root .env (packages/clawteam-gateway/src -> ../../../.env)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnv({ path: resolve(__dirname, '../../../.env') });

/** Create the appropriate OpenClaw session client based on config mode */
function createOpenClawClient(config: GatewayConfig, logger: Logger): IOpenClawSessionClient {
  if (config.openclawMode === 'cli') {
    return new OpenClawSessionCliClient(config.mainAgentId, logger, {
      openclawBin: config.openclawBin,
      sessionAliveThresholdMs: config.sessionAliveThresholdMs,
      openclawHome: config.openclawHome,
    });
  }

  // HTTP mode (fallback, for custom OpenClaw API implementations)
  return new OpenClawSessionClient(
    config.openclawApiUrl,
    `agent:${config.mainAgentId}:main`,
    logger,
    config.openclawApiKey,
  );
}

async function main() {
  // 1. Load config
  const config = loadConfig();

  // 2. Create logger
  const logger = createLogger({ level: config.logLevel, logDir: config.logDir });

  // 3. Print startup banner (before pino output)
  printStartupBanner(config);

  logger.info(
    { config: { ...config, clawteamApiKey: '***', openclawApiKey: '***' } },
    'ClawTeam Gateway starting',
  );

  // 3. Create clients
  const clawteamApi = new ClawTeamApiClient(
    config.clawteamApiUrl,
    config.clawteamApiKey,
    logger,
    config.clawteamBotId,
  );

  const openclawSession = createOpenClawClient(config, logger);
  logger.info({ mode: config.openclawMode, mainAgentId: config.mainAgentId }, 'OpenClaw client created');

  // 4. Create session tracker and shared routed-tasks tracker
  const sessionTracker = new SessionTracker();
  const routedTasks = new RoutedTasksTracker();

  // 4b. Spawn detection is now handled by the clawteam-auto-tracker OpenClaw plugin
  // (before_tool_call / after_tool_call hooks on sessions_spawn).
  // The plugin calls /gateway/track-session which handles accept + start + notify.

  // 5. Create router
  const gatewayUrl = `http://localhost:${config.gatewayPort}`;

  const router = new TaskRouter({
    clawteamApi,
    openclawSession,
    sessionTracker,
    logger,
    gatewayUrl,
    botId: config.clawteamBotId,
  });

  // 6. Create polling loop (shares routedTasks with recovery loop)
  const poller = new TaskPollingLoop({
    clawteamApi,
    router,
    pollIntervalMs: config.pollIntervalMs,
    pollLimit: config.pollLimit,
    logger,
    routedTasks,
  });

  // 7. Create heartbeat loop (optional, independent of polling)
  let heartbeatLoop: HeartbeatLoop | null = null;
  if (config.heartbeatEnabled && config.openclawMode === 'cli') {
    const resolver = new SessionStatusResolver({
      openclawBin: config.openclawBin,
      openclawHome: config.openclawHome,
      sessionAliveThresholdMs: config.sessionAliveThresholdMs,
      sessionTracker,
      logger,
    });

    heartbeatLoop = new HeartbeatLoop({
      resolver,
      clawteamApi,
      sessionTracker,
      intervalMs: config.heartbeatIntervalMs,
      logger,
    });
  }

  // 8. Create stale task recovery loop (optional, independent of polling)
  let recoveryLoop: StaleTaskRecoveryLoop | null = null;
  if (config.recoveryEnabled && config.openclawMode === 'cli') {
    const recoveryResolver = new SessionStatusResolver({
      openclawBin: config.openclawBin,
      openclawHome: config.openclawHome,
      sessionAliveThresholdMs: config.sessionAliveThresholdMs,
      sessionTracker,
      logger,
    });

    recoveryLoop = new StaleTaskRecoveryLoop({
      resolver: recoveryResolver,
      clawteamApi,
      openclawSession,
      sessionTracker,
      routedTasks,
      intervalMs: config.recoveryIntervalMs,
      stalenessThresholdMs: config.stalenessThresholdMs,
      toolCallingTimeoutMs: config.toolCallingTimeoutMs,
      maxRecoveryAttempts: config.maxRecoveryAttempts,
      mainSessionKey: `agent:${config.mainAgentId}:main`,
      gatewayUrl,
      botId: config.clawteamBotId,
      logger,
    });
  }

  // 9. Create Gateway API server (optional, for local-client + gateway proxy)
  let routerApi: RouterApiServer | null = null;
  let apiResolver: SessionStatusResolver | null = null;

  if (config.gatewayEnabled) {
    if (config.openclawMode === 'cli') {
      apiResolver = new SessionStatusResolver({
        openclawBin: config.openclawBin,
        openclawHome: config.openclawHome,
        sessionAliveThresholdMs: config.sessionAliveThresholdMs,
        sessionTracker,
        logger,
      });
    }

    routerApi = new RouterApiServer({
      sessionTracker,
      router,
      poller,
      heartbeatLoop,
      resolver: apiResolver,
      openclawSession,
      clawteamApi,
      clawteamApiUrl: config.clawteamApiUrl,
      clawteamApiKey: config.clawteamApiKey,
      clawteamBotId: config.clawteamBotId,
      pollIntervalMs: config.pollIntervalMs,
      logger,
      routedTasks,
      gatewayProxyEnabled: config.gatewayProxyEnabled,
      gatewayUrl,
      onBotIdChanged: (newBotId: string) => {
        logger.info({ newBotId }, 'Bot ID changed, updating all components');
        clawteamApi.setBotId(newBotId);
        recoveryLoop?.setBotId(newBotId);
        routerApi?.setBotId(newBotId);
      },
    });
  }

  // 10. Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down ClawTeam Gateway...');
    poller.stop();
    heartbeatLoop?.stop();
    recoveryLoop?.stop();
    await routerApi?.stop();
    const stats = sessionTracker.getStats();
    logger.info(stats, 'Final session tracker stats');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 11. Start polling, heartbeat, recovery, and API
  poller.start();
  heartbeatLoop?.start();
  recoveryLoop?.start();
  if (routerApi) {
    await routerApi.start(config.gatewayPort);
  }
}

main().catch((error) => {
  console.error('Fatal error starting ClawTeam Gateway:', error);
  process.exit(1);
});
