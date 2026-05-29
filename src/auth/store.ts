/**
 * Encrypted token store.
 *
 * Phase 1: AES-256-GCM with a key derived from a stable per-machine secret
 * (macOS IOPlatformUUID / Linux /etc/machine-id) + a per-install salt. Tokens
 * sit inside catalog.db (auth_tokens table) so backups/sync of a single file
 * carry both data and secrets together — easy to reason about, easy to wipe.
 *
 * Phase 2 will swap key derivation for the system keychain via `keytar`.
 *
 * Threat model (explicit, documented in README):
 *   - Protects against casual catalog.db disclosure (e.g. screen-share, backup)
 *   - Does NOT protect against an attacker who has both the DB and code-execution
 *     on the same machine (they can re-derive the same key)
 *   - This matches wsc's keys.toml stance and is acceptable for personal-machine use
 */

import { execSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { openCatalog } from '../catalog/store.ts';
import { configDir, ensureDirs } from '../util/paths.ts';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const ITER = 200_000;
const STATIC_SALT = Buffer.from('mcx:v1:salt:do-not-change-or-tokens-break', 'utf8');
const SALT_FILE = () => join(configDir, '.salt');

/** A stable per-machine seed. Falls back to hostname if platform-specific lookups fail. */
function machineSeed(): string {
  try {
    if (platform() === 'darwin') {
      const out = execSync(
        "ioreg -d2 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/{print $4}'",
        { encoding: 'utf8' },
      ).trim();
      if (out) return out;
    }
    if (platform() === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(p)) {
          const v = readFileSync(p, 'utf8').trim();
          if (v) return v;
        }
      }
    }
  } catch {
    /* fall through */
  }
  return hostname();
}

/** Per-install random salt, generated on first use. Stored in ~/.config/mcx/.salt. */
function installSalt(): Buffer {
  ensureDirs();
  const path = SALT_FILE();
  if (existsSync(path)) return readFileSync(path);
  const fresh = randomBytes(16);
  writeFileSync(path, fresh, { mode: 0o600 });
  return fresh;
}

let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const seed = machineSeed();
  const salt = Buffer.concat([STATIC_SALT, installSalt()]);
  cachedKey = pbkdf2Sync(seed, salt, ITER, KEY_LEN, 'sha256');
  return cachedKey;
}

/** Insert or replace a token for `server`. The plaintext can be a raw Bearer string OR
 *  a JSON-serialized OAuthTokenSet — callers decide and we treat it opaquely. */
export function setToken(server: string, plaintext: string): void {
  const key = masterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  openCatalog()
    .prepare(
      `INSERT INTO auth_tokens (server, ciphertext, iv, tag, created_at, last_used)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(server) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         iv = excluded.iv,
         tag = excluded.tag,
         created_at = excluded.created_at,
         last_used = NULL`,
    )
    .run(server, enc, iv, tag, Date.now());
}

/** Decrypt and return raw plaintext (Bearer string OR JSON token set). Updates last_used. */
export async function decryptRaw(server: string): Promise<string | null> {
  const row = openCatalog()
    .query('SELECT ciphertext, iv, tag FROM auth_tokens WHERE server = ?')
    .get(server) as {
    ciphertext: Buffer | Uint8Array;
    iv: Buffer | Uint8Array;
    tag: Buffer | Uint8Array;
  } | null;
  if (!row) return null;
  const key = masterKey();
  const decipher = createDecipheriv(ALGO, key, Buffer.from(row.iv));
  decipher.setAuthTag(Buffer.from(row.tag));
  try {
    const plain = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext)),
      decipher.final(),
    ]).toString('utf8');
    openCatalog()
      .prepare('UPDATE auth_tokens SET last_used = ? WHERE server = ?')
      .run(Date.now(), server);
    return plain;
  } catch (e) {
    const err = new Error(
      `failed to decrypt token for '${server}'. Master key may have changed (machine moved? salt deleted?). Re-run: mcx auth set ${server} --token <value>`,
    ) as Error & { code?: string };
    err.code = 'token_decrypt_failed';
    throw err;
  }
}

/** Convenience wrapper: returns the Bearer access_token (handles both plain + JSON-set forms). */
export async function decryptToken(server: string): Promise<string | null> {
  const raw = await decryptRaw(server);
  if (!raw) return null;
  // OAuth token set is JSON; static Bearer is a bare string.
  if (raw.startsWith('{')) {
    try {
      const set = JSON.parse(raw) as { access_token?: string };
      return set.access_token ?? null;
    } catch {
      return raw; // malformed; treat as raw bearer
    }
  }
  return raw;
}

/** Return the parsed OAuth token set (with refresh_token, expires_at) — or null if not OAuth. */
export interface PersistedTokenSet {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type: string;
  scope?: string;
}

export async function decryptTokenSet(server: string): Promise<PersistedTokenSet | null> {
  const raw = await decryptRaw(server);
  if (!raw || !raw.startsWith('{')) return null;
  try {
    return JSON.parse(raw) as PersistedTokenSet;
  } catch {
    return null;
  }
}
