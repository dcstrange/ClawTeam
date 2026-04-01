/**
 * Provider Factory
 *
 * 聚合一个 provider 的全部可注入组件（client, resolver, messageBuilder）
 * 并根据配置创建相应的 provider 实例。
 *
 * 当前使用 switch 工厂模式（2-3 个 provider 时最简洁）。
 * 若 provider 数量增长到 4+，应改为注册表模式（provider registry）。
 *
 * 添加新 provider 的步骤：
 * 1. 创建 providers/<name>/ 目录
 * 2. 实现 ISessionClient, IMessageBuilder, ISessionResolver（可选）
 * 3. 在本文件 createProvider() 的 switch 中添加 case
 * 4. 在 SessionProviderType 联合中添加类型值
 * 5. 在 config.ts 的 YamlConfig 中添加 provider 专属配置节
 */

import type { Logger } from 'pino';
import type { GatewayConfig } from '../config.js';
import type { ISessionClient, ISessionResolver, IMessageBuilder, SessionProviderType } from './types.js';
import { OpenClawSessionClient } from './openclaw/openclaw-session.js';
import { OpenClawSessionCliClient } from './openclaw/openclaw-session-cli.js';
import { OpenClawSessionResolver } from './openclaw/openclaw-session-resolver.js';
import { OpenClawMessageBuilder } from './openclaw/openclaw-message-builder.js';
import { SessionStatusResolver } from '../monitoring/session-status-resolver.js';

/**
 * SessionProvider — 聚合一个 provider 的全部可注入组件。
 *
 * index.ts 从 createProvider() 获取此对象，然后将各组件传入
 * TaskRouter、StaleTaskRecoveryLoop、RouterApiServer 等。
 */
export interface SessionProvider {
  readonly type: SessionProviderType;
  readonly client: ISessionClient;
  readonly resolver: ISessionResolver | null;
  readonly messageBuilder: IMessageBuilder;
  readonly mainSessionKey: string;
  /**
   * Provider 特定的具体 resolver（用于 router-api.ts 的调试端点）。
   *
   * router-api.ts 的 /sessions 和 /sessions/:key 端点调用了
   * resolveAllSessions()、fetchCliSessions()、resolveOne() 三个方法，
   * 这些不在 ISessionResolver 抽象接口中（它们是 OpenClaw 专属的调试功能）。
   *
   * RouterApiDeps.resolver 保持类型 SessionStatusResolver | null（不改为 ISessionResolver），
   * 由 index.ts 从此字段取值传入。非 OpenClaw provider 时为 null，
   * 调试端点返回空结果。
   */
  readonly concreteResolver?: SessionStatusResolver;
}

/**
 * 根据配置创建 session provider。
 *
 * @param config - Gateway 配置（含 sessionProvider 字段）
 * @param logger - Pino logger 实例
 * @param gatewayUrl - Gateway 基础 URL（用于 message builder 生成 curl 命令）
 * @returns 完整的 SessionProvider 对象
 * @throws 如果 provider 类型未知或启动检查失败
 */
export function createProvider(
  config: GatewayConfig,
  logger: Logger,
  gatewayUrl: string,
): SessionProvider {
  // 向后兼容：未配置 sessionProvider 时默认为 'openclaw'
  const providerType: SessionProviderType = config.sessionProvider ?? 'openclaw';

  switch (providerType) {
    case 'openclaw':
      return createOpenClawProvider(config, logger, gatewayUrl);
    case 'claude':
      // Phase 2: 实现后在此添加
      throw new Error(
        'Claude provider is not yet implemented. Set SESSION_PROVIDER=openclaw or remove the setting.',
      );
    default:
      throw new Error(`Unknown session provider: "${providerType}". Supported: openclaw, claude`);
  }
}

/**
 * 创建 OpenClaw provider 实例。
 *
 * 根据 openclawMode（'cli' | 'http'）选择不同的 session client 实现：
 * - cli: 使用 OpenClawSessionCliClient（spawn openclaw 二进制）
 * - http: 使用 OpenClawSessionClient（HTTP API）
 *
 * cli 模式同时创建 SessionStatusResolver 用于心跳和恢复循环。
 * http 模式下 resolver 为 null（不支持 JSONL 分析等功能）。
 */
function createOpenClawProvider(
  config: GatewayConfig,
  logger: Logger,
  gatewayUrl: string,
): SessionProvider {
  // openclawMode 验证（仅在 openclaw provider 中执行）
  if (config.openclawMode !== 'cli' && config.openclawMode !== 'http') {
    throw new Error(`Invalid OPENCLAW_MODE: "${config.openclawMode}". Must be "cli" or "http".`);
  }

  const mainSessionKey = `agent:${config.mainAgentId}:main`;
  const messageBuilder = new OpenClawMessageBuilder(gatewayUrl);

  let client: ISessionClient;
  let resolver: ISessionResolver | null = null;
  let concreteResolver: SessionStatusResolver | undefined;

  if (config.openclawMode === 'cli') {
    client = new OpenClawSessionCliClient(config.mainAgentId, logger, {
      openclawBin: config.openclawBin,
      sessionAliveThresholdMs: config.sessionAliveThresholdMs,
      openclawHome: config.openclawHome,
    });

    const statusResolver = new SessionStatusResolver({
      openclawBin: config.openclawBin,
      openclawHome: config.openclawHome,
      sessionAliveThresholdMs: config.sessionAliveThresholdMs,
      // sessionTracker is optional — not currently used by resolver methods
      logger,
    });
    const openclawResolver = new OpenClawSessionResolver(statusResolver);
    resolver = openclawResolver;
    concreteResolver = statusResolver;
  } else {
    // HTTP mode
    client = new OpenClawSessionClient(
      config.openclawApiUrl,
      mainSessionKey,
      logger,
      config.openclawApiKey,
    );
  }

  logger.info(
    { provider: 'openclaw', mode: config.openclawMode, mainAgentId: config.mainAgentId },
    'OpenClaw provider created',
  );

  return {
    type: 'openclaw',
    client,
    resolver,
    messageBuilder,
    mainSessionKey,
    concreteResolver,
  };
}
