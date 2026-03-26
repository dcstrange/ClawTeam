/**
 * Config Tests — Baseline for Provider Abstraction
 *
 * Verifies loadConfig() behavior:
 * - Environment variable priority over YAML
 * - openclawMode validation (only 'cli' | 'http' allowed)
 * - Default values for optional fields
 * - API key requirement
 *
 * After Commit 5 adds `sessionProvider`, these tests gain assertions
 * for backward compatibility (default to 'openclaw') and conditional
 * openclawMode validation.
 */

import { loadConfig } from '../src/config';

// ── Environment Isolation ─────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // Reset to known clean state — prevent ~/.clawteam/config.yaml interference
  process.env = {
    ...ORIGINAL_ENV,
    // Required field
    CLAWTEAM_API_KEY: 'test-api-key',
    // Prevent YAML config from loading (non-existent home)
    HOME: '/tmp/clawteam-config-test-nonexistent',
  };
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

// ── Tests ─────────────────────────────────────────────────────

describe('loadConfig', () => {
  describe('required fields', () => {
    it('throws when CLAWTEAM_API_KEY is not set', () => {
      delete process.env.CLAWTEAM_API_KEY;
      expect(() => loadConfig()).toThrow('API key is required');
    });

    it('loads successfully with only API key set', () => {
      const config = loadConfig();
      expect(config.clawteamApiKey).toBe('test-api-key');
    });
  });

  describe('default values', () => {
    it('defaults openclawMode to cli', () => {
      const config = loadConfig();
      expect(config.openclawMode).toBe('cli');
    });

    it('defaults clawteamApiUrl to http://localhost:3000', () => {
      const config = loadConfig();
      expect(config.clawteamApiUrl).toBe('http://localhost:3000');
    });

    it('defaults pollIntervalMs to 15000', () => {
      const config = loadConfig();
      expect(config.pollIntervalMs).toBe(15000);
    });

    it('defaults mainAgentId to main', () => {
      const config = loadConfig();
      expect(config.mainAgentId).toBe('main');
    });

    it('defaults heartbeatEnabled to true', () => {
      const config = loadConfig();
      expect(config.heartbeatEnabled).toBe(true);
    });

    it('defaults recoveryEnabled to true', () => {
      const config = loadConfig();
      expect(config.recoveryEnabled).toBe(true);
    });

    it('defaults gatewayEnabled to false', () => {
      const config = loadConfig();
      expect(config.gatewayEnabled).toBe(false);
    });

    it('defaults gatewayPort to 3100', () => {
      const config = loadConfig();
      expect(config.gatewayPort).toBe(3100);
    });

    it('defaults logLevel to info', () => {
      const config = loadConfig();
      expect(config.logLevel).toBe('info');
    });
  });

  describe('environment variable priority', () => {
    it('CLAWTEAM_API_URL overrides default', () => {
      process.env.CLAWTEAM_API_URL = 'http://custom:8080';
      const config = loadConfig();
      expect(config.clawteamApiUrl).toBe('http://custom:8080');
    });

    it('OPENCLAW_MODE overrides default', () => {
      process.env.OPENCLAW_MODE = 'http';
      const config = loadConfig();
      expect(config.openclawMode).toBe('http');
    });

    it('MAIN_AGENT_ID overrides default', () => {
      process.env.MAIN_AGENT_ID = 'bob';
      const config = loadConfig();
      expect(config.mainAgentId).toBe('bob');
    });

    it('GATEWAY_PORT overrides default', () => {
      process.env.GATEWAY_PORT = '4200';
      const config = loadConfig();
      expect(config.gatewayPort).toBe(4200);
    });

    it('HEARTBEAT_ENABLED=false disables heartbeat', () => {
      process.env.HEARTBEAT_ENABLED = 'false';
      const config = loadConfig();
      expect(config.heartbeatEnabled).toBe(false);
    });
  });

  describe('openclawMode validation', () => {
    it('accepts cli mode', () => {
      process.env.OPENCLAW_MODE = 'cli';
      const config = loadConfig();
      expect(config.openclawMode).toBe('cli');
    });

    it('accepts http mode', () => {
      process.env.OPENCLAW_MODE = 'http';
      const config = loadConfig();
      expect(config.openclawMode).toBe('http');
    });

    it('throws for invalid mode', () => {
      process.env.OPENCLAW_MODE = 'invalid';
      expect(() => loadConfig()).toThrow('Invalid OPENCLAW_MODE');
    });
  });

  describe('openclawHome path resolution', () => {
    it('resolves ~ in OPENCLAW_HOME', () => {
      process.env.OPENCLAW_HOME = '~/custom-openclaw';
      const config = loadConfig();
      // Should resolve ~ to actual home dir (from ORIGINAL_ENV)
      expect(config.openclawHome).not.toContain('~');
      expect(config.openclawHome).toContain('custom-openclaw');
    });
  });
});
