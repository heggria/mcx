import { openCatalog } from '../catalog/store.ts';

/**
 * Minimal auth-storage facade used by the backend factory.
 * Real encryption + key derivation lives in `src/auth/store.ts`; this file
 * only exposes the shape the backend layer needs.
 *
 * Phase 1: tokens stored AES-256-GCM-encrypted in the catalog DB so we don't
 * need a separate file. Phase 2: migrate to ~/.config/mcx/tokens.enc + keytar.
 */

export interface AuthTokenRow {
  server: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  created_at: number;
  last_used: number | null;
}

export function getEncryptedToken(server: string): AuthTokenRow | undefined {
  const r = openCatalog()
    .query('SELECT * FROM auth_tokens WHERE server = ?')
    .get(server);
  return (r ?? undefined) as AuthTokenRow | undefined;
}

export function touchToken(server: string): void {
  openCatalog()
    .prepare('UPDATE auth_tokens SET last_used = ? WHERE server = ?')
    .run(Date.now(), server);
}

export function deleteToken(server: string): boolean {
  const res = openCatalog().prepare('DELETE FROM auth_tokens WHERE server = ?').run(server);
  return res.changes > 0;
}

export function listTokenServers(): Array<{
  server: string;
  created_at: number;
  last_used: number | null;
}> {
  return openCatalog()
    .query('SELECT server, created_at, last_used FROM auth_tokens ORDER BY server')
    .all() as Array<{ server: string; created_at: number; last_used: number | null }>;
}
