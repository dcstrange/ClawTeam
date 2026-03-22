/**
 * Common Config - 环境变量配置加载
 */

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
  poolSize: number;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
}

export interface ApiConfig {
  host: string;
  port: number;
  jwtSecret: string;
  jwtExpiresIn: string;
}

export interface AppConfig {
  database: DatabaseConfig;
  redis: RedisConfig;
  api: ApiConfig;
  useMock: boolean;
  enableRateLimiting: boolean;
  logLevel: string;
}

/**
 * Parse DATABASE_URL into DatabaseConfig
 */
function parseDatabaseUrl(url: string): DatabaseConfig {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || 5432,
      database: parsed.pathname.slice(1),
      user: parsed.username,
      password: parsed.password,
      ssl: parsed.searchParams.get('ssl') === 'true',
      poolSize: parseInt(parsed.searchParams.get('pool_size') || '10', 10),
    };
  } catch {
    // Fallback for development
    return {
      host: 'localhost',
      port: 5432,
      database: 'clawteam',
      user: 'clawteam',
      password: 'changeme',
      ssl: false,
      poolSize: 10,
    };
  }
}

/**
 * Parse REDIS_URL into RedisConfig
 */
function parseRedisUrl(url: string): RedisConfig {
  try {
    const parsed = new URL(url);
    const dbMatch = parsed.pathname.match(/\/(\d+)/);
    return {
      host: parsed.hostname,
      port: parseInt(parsed.port, 10) || 6379,
      password: parsed.password || undefined,
      db: dbMatch ? parseInt(dbMatch[1], 10) : 0,
      keyPrefix: 'clawteam:',
    };
  } catch {
    // Fallback for development
    return {
      host: 'localhost',
      port: 6379,
      password: undefined,
      db: 0,
      keyPrefix: 'clawteam:',
    };
  }
}

/**
 * Load configuration from environment variables
 */
export function loadConfig(): AppConfig {
  const databaseUrl = process.env.DATABASE_URL || 'postgresql://clawteam:changeme@localhost:5432/clawteam';
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379/0';

  return {
    database: parseDatabaseUrl(databaseUrl),
    redis: parseRedisUrl(redisUrl),
    api: {
      host: process.env.API_HOST || '0.0.0.0',
      // Backward-compatible: support both API_PORT and PORT
      port: parseInt(process.env.API_PORT || process.env.PORT || '3000', 10),
      jwtSecret: process.env.JWT_SECRET || 'change-this-in-production',
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
    },
    useMock: process.env.USE_MOCK === 'true',
    enableRateLimiting: process.env.ENABLE_RATE_LIMITING !== 'false',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}

/** Singleton config instance */
let configInstance: AppConfig | null = null;

/**
 * Get the configuration (lazy loaded singleton)
 */
export function getConfig(): AppConfig {
  if (!configInstance) {
    configInstance = loadConfig();
  }
  return configInstance;
}

/**
 * Reset configuration (for testing)
 */
export function resetConfig(): void {
  configInstance = null;
}
