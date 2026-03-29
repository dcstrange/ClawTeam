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
import { createProvider } from './providers/provider-factory.js';
import { SessionTracker } from './routing/session-tracker.js';
import { RoutedTasksTracker } from './routing/routed-tasks.js';
import { TaskRouter } from './routing/router.js';
import { TaskPollingLoop } from './polling/task-poller.js';
import { HeartbeatLoop } from './monitoring/heartbeat-loop.js';
import { StaleTaskRecoveryLoop } from './recovery/stale-task-recovery-loop.js';
import { RouterApiServer } from './server/router-api.js';

// Load monorepo root .env (packages/clawteam-gateway/src -> ../../../.env)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
loadEnv({ path: resolve(__dirname, '../../../.env') });

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

  // 4. Create session provider (OpenClaw or Claude)
  const gatewayUrl = `http://localhost:${config.gatewayPort}`;
  const provider = createProvider(config, logger, gatewayUrl);

  // 5. Create session tracker and shared routed-tasks tracker
  const sessionTracker = new SessionTracker();
  const routedTasks = new RoutedTasksTracker();

  // 6. Create router
  const router = new TaskRouter({
    clawteamApi,
    sessionClient: provider.client,
    sessionTracker,
    messageBuilder: provider.messageBuilder,
    logger,
    gatewayUrl,
    botId: config.clawteamBotId,
  });

  // 7. Create polling loop (shares routedTasks with recovery loop)
  const poller = new TaskPollingLoop({
    clawteamApi,
    router,
    pollIntervalMs: config.pollIntervalMs,
    pollLimit: config.pollLimit,
    logger,
    routedTasks,
  });

  // 8. Create heartbeat loop (optional, requires resolver support)
  let heartbeatLoop: HeartbeatLoop | null = null;
  if (config.heartbeatEnabled && provider.resolver) {
    heartbeatLoop = new HeartbeatLoop({
      resolver: provider.resolver,
      clawteamApi,
      sessionTracker,
      intervalMs: config.heartbeatIntervalMs,
      logger,
    });
  }

  // 9. Create stale task recovery loop (optional, requires resolver support)
  let recoveryLoop: StaleTaskRecoveryLoop | null = null;
  if (config.recoveryEnabled && provider.resolver) {
    recoveryLoop = new StaleTaskRecoveryLoop({
      resolver: provider.resolver!,
      clawteamApi,
      sessionClient: provider.client,
      sessionTracker,
      messageBuilder: provider.messageBuilder,
      routedTasks,
      intervalMs: config.recoveryIntervalMs,
      stalenessThresholdMs: config.stalenessThresholdMs,
      toolCallingTimeoutMs: config.toolCallingTimeoutMs,
      maxRecoveryAttempts: config.maxRecoveryAttempts,
      mainSessionKey: provider.mainSessionKey,
      gatewayUrl,
      botId: config.clawteamBotId,
      logger,
    });
  }

  // 10. Create Gateway API server (optional, for local-client + gateway proxy)
  let routerApi: RouterApiServer | null = null;

  if (config.gatewayEnabled) {
    routerApi = new RouterApiServer({
      sessionTracker,
      router,
      poller,
      heartbeatLoop,
      resolver: provider.concreteResolver ?? null,
      sessionClient: provider.client,
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
