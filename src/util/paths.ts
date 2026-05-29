import { mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * XDG-compliant path resolution.
 * macOS: respects XDG_* env vars when set, otherwise falls back to ~/.config and ~/.local/state
 * Linux: standard XDG
 * Windows: not supported in Phase 1
 */

function envPath(envVar: string, fallback: string): string {
  const v = process.env[envVar];
  return v && v.length > 0 ? v : fallback;
}

const home = homedir();

export const configHome = envPath('XDG_CONFIG_HOME', join(home, '.config'));
export const stateHome = envPath('XDG_STATE_HOME', join(home, '.local', 'state'));
export const cacheHome = envPath('XDG_CACHE_HOME', join(home, '.cache'));

export const configDir = join(configHome, 'mcx');
export const stateDir = join(stateHome, 'mcx');
export const cacheDir = join(cacheHome, 'mcx');

export const backendsConfigPath = (override?: string): string =>
  override ?? join(configDir, 'backends.toml');

export const catalogDbPath = (): string => join(stateDir, 'catalog.db');
export const auditLogPath = (): string => join(stateDir, 'audit.jsonl');
export const tokensPath = (): string => join(configDir, 'tokens.enc');
export const masterKeyPath = (): string => join(configDir, '.master.key');

export function ensureDirs(): void {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
}

export const isMac = platform() === 'darwin';
export const isLinux = platform() === 'linux';
