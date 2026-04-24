import { Database } from 'bun:sqlite';
import { catalogDbPath, ensureDirs } from '../util/paths.ts';

/**
 * SQLite catalog with FTS5 BM25 search, backed by Bun's built-in `bun:sqlite`.
 * Bun ships SQLite with FTS5 enabled, so no native compilation is needed.
 *
 * Tables:
 *   - servers       : index status per backend
 *   - tools         : one row per (server, tool); input_schema_json is raw JSON
 *   - auth_tokens   : managed by src/auth/store.ts (defined here for cohesion)
 *
 * FTS5 virtual table:
 *   - tools_fts     : externally-content table, kept in sync via triggers
 *
 * Schema initialized lazily on first open. Migrations track via PRAGMA user_version.
 */

const SCHEMA_VERSION = 2;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS servers (
  name        TEXT PRIMARY KEY,
  transport   TEXT NOT NULL,
  url         TEXT,
  indexed_at  INTEGER,
  tool_count  INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE TABLE IF NOT EXISTS tools (
  id                 INTEGER PRIMARY KEY,
  server             TEXT NOT NULL REFERENCES servers(name) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  description        TEXT,
  input_schema_json  TEXT,
  args_text          TEXT,
  UNIQUE(server, name)
);

CREATE INDEX IF NOT EXISTS idx_tools_server ON tools(server);

-- FTS5 virtual table; external content tied to tools.id (rowid).
-- Column weights at query time: bm25(tools_fts, 10.0, 3.0, 1.0)
--   name=10  description=3  args_text=1
CREATE VIRTUAL TABLE IF NOT EXISTS tools_fts USING fts5(
  name, description, args_text,
  content='tools',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

-- Sync triggers: keep tools_fts mirror in lock-step with tools.
CREATE TRIGGER IF NOT EXISTS tools_ai AFTER INSERT ON tools BEGIN
  INSERT INTO tools_fts(rowid, name, description, args_text)
  VALUES (new.id, new.name, new.description, new.args_text);
END;

CREATE TRIGGER IF NOT EXISTS tools_ad AFTER DELETE ON tools BEGIN
  INSERT INTO tools_fts(tools_fts, rowid, name, description, args_text)
  VALUES ('delete', old.id, old.name, old.description, old.args_text);
END;

CREATE TRIGGER IF NOT EXISTS tools_au AFTER UPDATE ON tools BEGIN
  INSERT INTO tools_fts(tools_fts, rowid, name, description, args_text)
  VALUES ('delete', old.id, old.name, old.description, old.args_text);
  INSERT INTO tools_fts(rowid, name, description, args_text)
  VALUES (new.id, new.name, new.description, new.args_text);
END;

CREATE TABLE IF NOT EXISTS auth_tokens (
  server      TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,
  tag         BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);

-- Phase 2: per-tool embeddings for hybrid search.
-- vec is a packed Float32Array (4 bytes per dim). model + dim let us detect stale
-- embeddings when the user switches providers.
CREATE TABLE IF NOT EXISTS tool_embeddings (
  tool_id     INTEGER PRIMARY KEY REFERENCES tools(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_embed_model ON tool_embeddings(model);

-- OAuth state: per-server PKCE sessions and DCR client registrations.
CREATE TABLE IF NOT EXISTS oauth_clients (
  server                  TEXT PRIMARY KEY,
  authorization_endpoint  TEXT NOT NULL,
  token_endpoint          TEXT NOT NULL,
  registration_endpoint   TEXT,
  client_id               TEXT NOT NULL,
  client_secret           TEXT,
  scope                   TEXT,
  redirect_uri            TEXT NOT NULL,
  created_at              INTEGER NOT NULL
);
`;

let cached: Database | null = null;

export function openCatalog(): Database {
  if (cached) return cached;
  ensureDirs();
  const db = new Database(catalogDbPath(), { create: true });
  db.exec(SCHEMA_SQL);
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
  const current = row?.user_version ?? 0;
  if (current < SCHEMA_VERSION) {
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  cached = db;
  return db;
}

export function closeCatalog(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

// Best-effort cleanup on normal process exit. We deliberately DON'T checkpoint
// the WAL here — Bun's `process.on('exit')` runs synchronously and a forced
// PRAGMA wal_checkpoint(TRUNCATE) under contention from multiple short-lived
// CLI invocations was observed to drop committed rows. SQLite's normal
// auto-checkpoint (WAL passes 1000 frames) handles this safely.
let exitHooked = false;
function ensureExitHook(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    if (cached) {
      try {
        cached.close();
      } catch {
        /* ignore */
      }
      cached = null;
    }
  });
}
ensureExitHook();

export interface ServerRow {
  name: string;
  transport: string;
  url: string | null;
  indexed_at: number | null;
  tool_count: number;
  last_error: string | null;
}

export interface ToolRow {
  id: number;
  server: string;
  name: string;
  description: string | null;
  input_schema_json: string | null;
  args_text: string | null;
}

export interface ToolWithScore extends ToolRow {
  score: number;
}

/** Replace all tools for a server in one transaction (for `mcx index`). */
export function replaceTools(
  server: string,
  transport: string,
  url: string | null,
  tools: Array<{
    name: string;
    description?: string | undefined;
    inputSchema?: unknown;
  }>,
  errorIfAny?: string,
): void {
  const db = openCatalog();
  const upsertServer = db.prepare(
    `INSERT INTO servers (name, transport, url, indexed_at, tool_count, last_error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       transport=excluded.transport,
       url=excluded.url,
       indexed_at=excluded.indexed_at,
       tool_count=excluded.tool_count,
       last_error=excluded.last_error`,
  );
  const deleteTools = db.prepare('DELETE FROM tools WHERE server = ?');
  const insertTool = db.prepare(
    `INSERT INTO tools (server, name, description, input_schema_json, args_text)
     VALUES (?, ?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    upsertServer.run(server, transport, url, Date.now(), tools.length, errorIfAny ?? null);
    deleteTools.run(server);
    for (const t of tools) {
      const schemaJson = t.inputSchema ? JSON.stringify(t.inputSchema) : null;
      const argsText = extractArgsText(t.inputSchema);
      insertTool.run(server, t.name, t.description ?? null, schemaJson, argsText);
    }
  });
  tx();
}

/** Mark a server as failed without touching its existing tool rows. */
export function markServerError(
  server: string,
  transport: string,
  url: string | null,
  msg: string,
): void {
  const db = openCatalog();
  const upsertServer = db.prepare(
    `INSERT INTO servers (name, transport, url, indexed_at, tool_count, last_error)
     VALUES (?, ?, ?, ?, COALESCE((SELECT tool_count FROM servers WHERE name = ?), 0), ?)
     ON CONFLICT(name) DO UPDATE SET
       transport=excluded.transport,
       url=excluded.url,
       indexed_at=excluded.indexed_at,
       last_error=excluded.last_error`,
  );
  upsertServer.run(server, transport, url, Date.now(), server, msg);
}

export function listServers(): ServerRow[] {
  return openCatalog().query('SELECT * FROM servers ORDER BY name').all() as ServerRow[];
}

export function listTools(server?: string): ToolRow[] {
  const db = openCatalog();
  if (server) {
    return db
      .query('SELECT * FROM tools WHERE server = ? ORDER BY name')
      .all(server) as ToolRow[];
  }
  return db.query('SELECT * FROM tools ORDER BY server, name').all() as ToolRow[];
}

export function findTool(server: string, tool: string): ToolRow | undefined {
  const r = openCatalog()
    .query('SELECT * FROM tools WHERE server = ? AND name = ?')
    .get(server, tool);
  return (r ?? undefined) as ToolRow | undefined;
}

/**
 * BM25 search across name (10), description (3), args_text (1).
 * FTS5 returns negative scores; ORDER BY ASC so most-relevant first.
 */
export function searchTools(
  query: string,
  opts: { topN?: number; server?: string } = {},
): ToolWithScore[] {
  const db = openCatalog();
  const topN = opts.topN ?? 5;
  const escaped = escapeFtsQuery(query);
  if (opts.server) {
    return db
      .query(
        `SELECT t.*, bm25(tools_fts, 10.0, 3.0, 1.0) AS score
         FROM tools_fts
         JOIN tools t ON t.id = tools_fts.rowid
         WHERE tools_fts MATCH ? AND t.server = ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(escaped, opts.server, topN) as ToolWithScore[];
  }
  return db
    .query(
      `SELECT t.*, bm25(tools_fts, 10.0, 3.0, 1.0) AS score
       FROM tools_fts
       JOIN tools t ON t.id = tools_fts.rowid
       WHERE tools_fts MATCH ?
       ORDER BY score ASC
       LIMIT ?`,
    )
    .all(escaped, topN) as ToolWithScore[];
}

/**
 * FTS5 query escaping. We adopt a pragmatic strategy:
 *   - Strip FTS5-reserved punctuation that would otherwise break the parser
 *   - Quote each remaining whitespace-separated token to make it a literal
 *   - Join with OR so any-match still ranks via BM25 (top-N stays useful)
 *
 * Trades some power-user features (NEAR, prefix wildcards) for never-crashing
 * on free-form input — exactly what we want from a CLI.
 *
 * Why OR over AND: a query like "take screenshot browser" with implicit AND
 * misses chrome-devtools.take_screenshot because its description never says
 * "browser". OR + BM25 ranking surfaces the right tool first; less-matching
 * tools naturally rank lower.
 */
function escapeFtsQuery(q: string): string {
  const tokens = q
    .replace(/["'()*?:^]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !FTS_KEYWORDS.has(t.toUpperCase()));
  if (tokens.length === 0) return '""';
  if (tokens.length === 1) return `"${tokens[0]}"`;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

const FTS_KEYWORDS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Build args_text from a JSON Schema input_schema for FTS5 indexing.
 * Concatenates property names + descriptions so search matches argument terms too.
 */
function extractArgsText(schema: unknown): string | null {
  if (!schema || typeof schema !== 'object') return null;
  const s = schema as { properties?: Record<string, unknown>; required?: string[] };
  if (!s.properties) return null;
  const parts: string[] = [];
  for (const [propName, propDef] of Object.entries(s.properties)) {
    parts.push(propName);
    if (propDef && typeof propDef === 'object') {
      const d = (propDef as { description?: string }).description;
      if (d) parts.push(d);
    }
  }
  return parts.join(' ').slice(0, 4000);
}

/* ───────────────── Phase 2: embedding storage ───────────────── */

export interface ToolEmbedding {
  tool_id: number;
  model: string;
  dim: number;
  vec: Float32Array;
}

/** Upsert an embedding for a single tool. */
export function upsertEmbedding(toolId: number, model: string, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  openCatalog()
    .prepare(
      `INSERT INTO tool_embeddings (tool_id, model, dim, vec, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tool_id) DO UPDATE SET
         model = excluded.model,
         dim = excluded.dim,
         vec = excluded.vec,
         created_at = excluded.created_at`,
    )
    .run(toolId, model, vec.length, buf, Date.now());
}

/** Tools that don't yet have an embedding for the active model. */
export function toolsMissingEmbedding(model: string): ToolRow[] {
  return openCatalog()
    .query(
      `SELECT t.* FROM tools t
       LEFT JOIN tool_embeddings e ON e.tool_id = t.id AND e.model = ?
       WHERE e.tool_id IS NULL
       ORDER BY t.server, t.name`,
    )
    .all(model) as ToolRow[];
}

/** Bulk-fetch embeddings for a set of tool ids. */
export function getEmbeddings(toolIds: number[], model: string): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  if (toolIds.length === 0) return out;
  // SQLite parameter limit is 999; chunk if needed.
  const CHUNK = 500;
  for (let i = 0; i < toolIds.length; i += CHUNK) {
    const slice = toolIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = openCatalog()
      .query(
        `SELECT tool_id, vec FROM tool_embeddings
         WHERE model = ? AND tool_id IN (${placeholders})`,
      )
      .all(model, ...slice) as Array<{ tool_id: number; vec: Buffer | Uint8Array }>;
    for (const r of rows) {
      const u8 = Buffer.isBuffer(r.vec) ? r.vec : Buffer.from(r.vec);
      out.set(r.tool_id, new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4));
    }
  }
  return out;
}

/** Stats: how many tools have embeddings vs total. */
export function embeddingStats(model?: string): {
  total_tools: number;
  embedded: number;
  models: Array<{ model: string; count: number }>;
} {
  const db = openCatalog();
  const total = (db.query('SELECT count(*) as c FROM tools').get() as { c: number }).c;
  const embedded = model
    ? (db.query('SELECT count(*) as c FROM tool_embeddings WHERE model = ?').get(model) as {
        c: number;
      }).c
    : (db.query('SELECT count(*) as c FROM tool_embeddings').get() as { c: number }).c;
  const models = db
    .query('SELECT model, count(*) as count FROM tool_embeddings GROUP BY model')
    .all() as Array<{ model: string; count: number }>;
  return { total_tools: total, embedded, models };
}

/** Stream all (tool_id, vec) pairs for a model — used by cosine fallback when BM25 misses. */
export function allEmbeddings(model: string): Array<{ tool_id: number; vec: Float32Array }> {
  const rows = openCatalog()
    .query('SELECT tool_id, vec FROM tool_embeddings WHERE model = ?')
    .all(model) as Array<{ tool_id: number; vec: Buffer | Uint8Array }>;
  return rows.map((r) => {
    const u8 = Buffer.isBuffer(r.vec) ? r.vec : Buffer.from(r.vec);
    return {
      tool_id: r.tool_id,
      vec: new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4),
    };
  });
}

/** Hydrate ToolRow objects by id (preserves insertion order of input). */
export function getToolsByIds(ids: number[]): ToolRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = openCatalog()
    .query(`SELECT * FROM tools WHERE id IN (${placeholders})`)
    .all(...ids) as ToolRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i)).filter((r): r is ToolRow => !!r);
}
