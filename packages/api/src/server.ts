/**
 * ClawTeam Platform API Server
 *
 * 入口文件 - 使用 bootstrap 初始化并启动服务器
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { config as loadEnv } from 'dotenv';

// ESM 环境下获取 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 加载环境变量 (从 monorepo 根目录)
loadEnv({ path: resolve(__dirname, '../../../.env') });

import { createServer, startServer, shutdown } from './bootstrap';

async function main(): Promise<void> {
  const { server } = await createServer();

  // 优雅关闭
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
  signals.forEach((signal) => {
    process.on(signal, async () => {
      server.log.info(`Received ${signal}, starting graceful shutdown...`);
      await shutdown(server);
      process.exit(0);
    });
  });

  // 启动服务器
  const address = await startServer(server);

  server.log.info(`ClawTeam Platform API running at ${address}`);
  server.log.info(`Health check: ${address}/health`);
  server.log.info(`WebSocket: ${address.replace('http', 'ws')}/ws`);
  server.log.info(`API docs: ${address}/docs`);
}

main().catch((err) => {
  console.error('Fatal error starting server:', err);
  process.exit(1);
});
