import * as path from 'node:path';

function normalizeStateDir(openclawHome: string): string {
  return path.resolve(openclawHome);
}

function deriveOpenclawHomeForCli(stateDir: string): string {
  const normalized = path.resolve(stateDir);
  // OpenClaw CLI interprets OPENCLAW_HOME as "home root" and appends ".openclaw".
  // Our gateway config stores the state dir itself (usually ".../.openclaw").
  // Map state dir -> home root for compatibility.
  if (path.basename(normalized) === '.openclaw') {
    return path.dirname(normalized);
  }
  return normalized;
}

/**
 * Build a stable env for OpenClaw CLI child processes.
 * Ensures CLI commands read/write the same state dir as gateway file lookups.
 */
export function buildOpenclawCliEnv(openclawHome: string): NodeJS.ProcessEnv {
  const stateDir = normalizeStateDir(openclawHome);
  const cliHome = deriveOpenclawHomeForCli(stateDir);

  return {
    ...process.env,
    OPENCLAW_HOME: cliHome,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
  };
}

