import { Database } from 'bun:sqlite';
import { catalogDbPath, ensureDirs } from '../util/paths.ts';

/**
 * SQLite catalog with FTS5 BM25 search, backed by Bun's built-in `bun:sqlite`.
 *
 * Tables (v3, unified tool + skill catalog):
 *   - servers           : MCP backend index status
 *   - skill_roots       : skill scan roots metadata
 *   - entities          : one row per (kind, source, name) — kind ∈ {'tool','skill'}
 *   - entity_embeddings : per-entity Float32Array embedding
 *   - auth_tokens       : managed by src/auth/store.ts
 *   - oauth_clients     : OAuth 2.1 DCR client registrations
 *
 * FTS5 virtual table:
 *   - entities_fts : externally-content table, kept in sync via triggers
 *
 * Legacy v2 tables (tools, tool_embeddings, tools_fts) are migrated then dropped.
 */

const SCHEMA_VERSION = 3;

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

CREATE TABLE IF NOT EXISTS skill_roots (
  id          INTEGER PRIMARY KEY,
  path        TEXT UNIQUE NOT NULL,
  indexed_at  INTEGER,
  skill_count INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT
);

CREATE TABLE IF NOT EXISTS entities (
  id                  INTEGER PRIMARY KEY,
  kind                TEXT NOT NULL CHECK(kind IN ('tool','skill')),
  source              TEXT NOT NULL,
  name                TEXT NOT NULL,
  description         TEXT,
  body_path           TEXT,
  body_size           INTEGER,
  args_text           TEXT,
  input_schema_json   TEXT,
  triggers            TEXT,
  updated_at          INTEGER NOT NULL,
  UNIQUE(kind, source, name)
);

CREATE INDEX IF NOT EXISTS idx_entities_kind   ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name, description, args_text, triggers,
  content='entities',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name, description, args_text, triggers)
  VALUES (new.id, new.name, new.description, new.args_text, new.triggers);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, description, args_text, triggers)
  VALUES ('delete', old.id, old.name, old.description, old.args_text, old.triggers);
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name, description, args_text, triggers)
  VALUES ('delete', old.id, old.name, old.description, old.args_text, old.triggers);
  INSERT INTO entities_fts(rowid, name, description, args_text, triggers)
  VALUES (new.id, new.name, new.description, new.args_text, new.triggers);
END;

CREATE TABLE IF NOT EXISTS entity_embeddings (
  entity_id   INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_embed_model ON entity_embeddings(model);

CREATE TABLE IF NOT EXISTS auth_tokens (
  server      TEXT PRIMARY KEY,
  ciphertext  BLOB NOT NULL,
  iv          BLOB NOT NULL,
  tag         BLOB NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);

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
    migrateUp(db, current);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }
  cached = db;
  return db;
}

/** Forward migration. v0 → v3 is no-op (fresh schema). v2 → v3 copies tools → entities. */
function migrateUp(db: Database, from: number): void {
  if (from === 2) {
    try {
      const hasTools = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='tools'")
        .get();
      if (hasTools) {
        db.exec(`
          INSERT OR IGNORE INTO entities
            (kind, source, name, description, body_path, body_size,
             args_text, input_schema_json, triggers, updated_at)
          SELECT 'tool', 'server:' || server, name, description,
                 NULL, NULL, args_text, input_schema_json, NULL, ${Date.now()}
          FROM tools
        `);
        db.exec(`
          INSERT OR IGNORE INTO entity_embeddings (entity_id, model, dim, vec, created_at)
          SELECT e.id, te.model, te.dim, te.vec, te.created_at
          FROM tool_embeddings te
          JOIN tools t ON t.id = te.tool_id
          JOIN entities e ON e.kind = 'tool'
                          AND e.source = 'server:' || t.server
                          AND e.name = t.name
        `);
        db.exec('DROP TABLE IF EXISTS tool_embeddings');
        db.exec('DROP TABLE IF EXISTS tools_fts');
        db.exec('DROP TABLE IF EXISTS tools');
      }
    } catch (e) {
      process.stderr.write(`mcx: v2→v3 migration partial: ${(e as Error).message}\n`);
    }
  }
}

export function closeCatalog(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

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

/* ───────────────── Server / skill-root metadata ───────────────── */

export interface ServerRow {
  name: string;
  transport: string;
  url: string | null;
  indexed_at: number | null;
  tool_count: number;
  last_error: string | null;
}

export interface SkillRootRow {
  id: number;
  path: string;
  indexed_at: number | null;
  skill_count: number;
  last_error: string | null;
}

export function listServers(): ServerRow[] {
  return openCatalog().query('SELECT * FROM servers ORDER BY name').all() as ServerRow[];
}

export function listSkillRoots(): SkillRootRow[] {
  return openCatalog().query('SELECT * FROM skill_roots ORDER BY path').all() as SkillRootRow[];
}

/* ───────────────── Unified entity API ───────────────── */

export type EntityKind = 'tool' | 'skill';

export interface EntityRow {
  id: number;
  kind: EntityKind;
  source: string;
  name: string;
  description: string | null;
  body_path: string | null;
  body_size: number | null;
  args_text: string | null;
  input_schema_json: string | null;
  triggers: string | null;
  updated_at: number;
}

export interface EntityWithScore extends EntityRow {
  score: number;
}

export interface ToolUpsertInput {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

export interface SkillUpsertInput {
  name: string;
  description?: string | undefined;
  triggers?: string | undefined;
  bodyPath: string;
  bodySize: number;
}

/** Replace all tools for one MCP server in a single transaction. */
export function replaceTools(
  server: string,
  transport: string,
  url: string | null,
  tools: ToolUpsertInput[],
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
  const deleteOld = db.prepare(`DELETE FROM entities WHERE kind = 'tool' AND source = ?`);
  const insertEntity = db.prepare(
    `INSERT INTO entities
       (kind, source, name, description, body_path, body_size,
        args_text, input_schema_json, triggers, updated_at)
     VALUES ('tool', ?, ?, ?, NULL, NULL, ?, ?, NULL, ?)`,
  );

  const source = `server:${server}`;
  const now = Date.now();

  const tx = db.transaction(() => {
    upsertServer.run(server, transport, url, now, tools.length, errorIfAny ?? null);
    deleteOld.run(source);
    for (const t of tools) {
      const schemaJson = t.inputSchema ? JSON.stringify(t.inputSchema) : null;
      const argsText = extractArgsText(t.inputSchema);
      insertEntity.run(source, t.name, t.description ?? null, argsText, schemaJson, now);
    }
  });
  tx();
}

/** Replace all skills for one skill-root in a single transaction. */
export function replaceSkills(rootPath: string, skills: SkillUpsertInput[]): SkillRootRow {
  const db = openCatalog();
  const now = Date.now();

  const upsertRoot = db.prepare(
    `INSERT INTO skill_roots (path, indexed_at, skill_count, last_error)
     VALUES (?, ?, ?, NULL)
     ON CONFLICT(path) DO UPDATE SET
       indexed_at=excluded.indexed_at,
       skill_count=excluded.skill_count,
       last_error=NULL
     RETURNING id`,
  );

  const tx = db.transaction(() => {
    const rootRow = upsertRoot.get(rootPath, now, skills.length) as { id: number };
    const source = `skill-root:${rootRow.id}`;

    db.prepare(`DELETE FROM entities WHERE kind = 'skill' AND source = ?`).run(source);

    const insertEntity = db.prepare(
      `INSERT INTO entities
         (kind, source, name, description, body_path, body_size,
          args_text, input_schema_json, triggers, updated_at)
       VALUES ('skill', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    );
    for (const s of skills) {
      insertEntity.run(
        source,
        s.name,
        s.description ?? null,
        s.bodyPath,
        s.bodySize,
        s.triggers ?? null,
        now,
      );
    }
    return rootRow;
  });

  const root = tx();
  return db.prepare('SELECT * FROM skill_roots WHERE id = ?').get(root.id) as SkillRootRow;
}

export function markServerError(
  server: string,
  transport: string,
  url: string | null,
  msg: string,
): void {
  openCatalog()
    .prepare(
      `INSERT INTO servers (name, transport, url, indexed_at, tool_count, last_error)
     VALUES (?, ?, ?, ?, COALESCE((SELECT tool_count FROM servers WHERE name = ?), 0), ?)
     ON CONFLICT(name) DO UPDATE SET
       transport=excluded.transport,
       url=excluded.url,
       indexed_at=excluded.indexed_at,
       last_error=excluded.last_error`,
    )
    .run(server, transport, url, Date.now(), server, msg);
}

export function markSkillRootError(rootPath: string, msg: string): void {
  openCatalog()
    .prepare(
      `INSERT INTO skill_roots (path, indexed_at, skill_count, last_error)
     VALUES (?, ?, COALESCE((SELECT skill_count FROM skill_roots WHERE path = ?), 0), ?)
     ON CONFLICT(path) DO UPDATE SET
       indexed_at=excluded.indexed_at,
       last_error=excluded.last_error`,
    )
    .run(rootPath, Date.now(), rootPath, msg);
}

export interface ListEntitiesOptions {
  kind?: EntityKind;
  source?: string;
}

export function listEntities(opts: ListEntitiesOptions = {}): EntityRow[] {
  const db = openCatalog();
  const where: string[] = [];
  const args: (string | number | null)[] = [];
  if (opts.kind) {
    where.push('kind = ?');
    args.push(opts.kind);
  }
  if (opts.source) {
    where.push('source = ?');
    args.push(opts.source);
  }
  const sql = `SELECT * FROM entities ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY kind, source, name`;
  return db.query(sql).all(...args) as EntityRow[];
}

export function findEntity(kind: EntityKind, name: string, source?: string): EntityRow | undefined {
  const db = openCatalog();
  if (source) {
    const r = db
      .query('SELECT * FROM entities WHERE kind = ? AND name = ? AND source = ?')
      .get(kind, name, source);
    return (r ?? undefined) as EntityRow | undefined;
  }
  const r = db
    .query('SELECT * FROM entities WHERE kind = ? AND name = ? ORDER BY source LIMIT 1')
    .get(kind, name);
  return (r ?? undefined) as EntityRow | undefined;
}

/** Convenience: shape that legacy callers expect (server + name). */
export interface ToolRow {
  id: number;
  server: string;
  name: string;
  description: string | null;
  input_schema_json: string | null;
  args_text: string | null;
}

export function findTool(server: string, tool: string): ToolRow | undefined {
  const e = findEntity('tool', tool, `server:${server}`);
  if (!e) return undefined;
  return entityToToolRow(e);
}

export function listTools(server?: string): ToolRow[] {
  const opts: ListEntitiesOptions = { kind: 'tool' };
  if (server) opts.source = `server:${server}`;
  return listEntities(opts).map(entityToToolRow);
}

function entityToToolRow(e: EntityRow): ToolRow {
  if (!e.source.startsWith('server:')) {
    throw new Error(`entity ${e.id} has unexpected tool source: ${e.source}`);
  }
  return {
    id: e.id,
    server: e.source.slice('server:'.length),
    name: e.name,
    description: e.description,
    input_schema_json: e.input_schema_json,
    args_text: e.args_text,
  };
}

/** BM25 hybrid search. Optionally filter by kind and/or source. */
export interface SearchEntitiesOptions {
  topN?: number;
  kind?: EntityKind;
  source?: string;
}

export function searchEntities(query: string, opts: SearchEntitiesOptions = {}): EntityWithScore[] {
  const db = openCatalog();
  const topN = opts.topN ?? 5;
  const escaped = escapeFtsQuery(query);
  const where: string[] = ['entities_fts MATCH ?'];
  const args: (string | number | null)[] = [escaped];
  if (opts.kind) {
    where.push('e.kind = ?');
    args.push(opts.kind);
  }
  if (opts.source) {
    where.push('e.source = ?');
    args.push(opts.source);
  }
  args.push(topN);
  return db
    .query(
      `SELECT e.*, bm25(entities_fts, 10.0, 3.0, 1.0, 5.0) AS score
       FROM entities_fts
       JOIN entities e ON e.id = entities_fts.rowid
       WHERE ${where.join(' AND ')}
       ORDER BY score ASC
       LIMIT ?`,
    )
    .all(...args) as EntityWithScore[];
}

/** Legacy wrapper. */
export interface ToolWithScore extends ToolRow {
  score: number;
}

export function searchTools(
  query: string,
  opts: { topN?: number; server?: string } = {},
): ToolWithScore[] {
  const searchOpts: SearchEntitiesOptions = { kind: 'tool' };
  if (opts.topN !== undefined) searchOpts.topN = opts.topN;
  if (opts.server) searchOpts.source = `server:${opts.server}`;
  const ents = searchEntities(query, searchOpts);
  return ents.map((e) => ({ ...entityToToolRow(e), score: e.score }));
}

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

/* ───────────────── Entity embedding storage ───────────────── */

export interface EntityEmbedding {
  entity_id: number;
  model: string;
  dim: number;
  vec: Float32Array;
}

export function upsertEmbedding(entityId: number, model: string, vec: Float32Array): void {
  const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  openCatalog()
    .prepare(
      `INSERT INTO entity_embeddings (entity_id, model, dim, vec, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(entity_id) DO UPDATE SET
         model = excluded.model,
         dim = excluded.dim,
         vec = excluded.vec,
         created_at = excluded.created_at`,
    )
    .run(entityId, model, vec.length, buf, Date.now());
}

export function entitiesMissingEmbedding(model: string, kind?: EntityKind): EntityRow[] {
  const db = openCatalog();
  const kindFilter = kind ? 'AND e.kind = ?' : '';
  const args: (string | number | null)[] = [model];
  if (kind) args.push(kind);
  return db
    .query(
      `SELECT e.* FROM entities e
       LEFT JOIN entity_embeddings emb ON emb.entity_id = e.id AND emb.model = ?
       WHERE emb.entity_id IS NULL ${kindFilter}
       ORDER BY e.kind, e.source, e.name`,
    )
    .all(...args) as EntityRow[];
}

export function toolsMissingEmbedding(model: string): ToolRow[] {
  return entitiesMissingEmbedding(model, 'tool').map(entityToToolRow);
}

export function getEmbeddings(entityIds: number[], model: string): Map<number, Float32Array> {
  const out = new Map<number, Float32Array>();
  if (entityIds.length === 0) return out;
  const CHUNK = 500;
  for (let i = 0; i < entityIds.length; i += CHUNK) {
    const slice = entityIds.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const rows = openCatalog()
      .query(
        `SELECT entity_id, vec FROM entity_embeddings
         WHERE model = ? AND entity_id IN (${placeholders})`,
      )
      .all(model, ...slice) as Array<{ entity_id: number; vec: Buffer | Uint8Array }>;
    for (const r of rows) {
      const u8 = Buffer.isBuffer(r.vec) ? r.vec : Buffer.from(r.vec);
      out.set(r.entity_id, new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4));
    }
  }
  return out;
}

export function embeddingStats(model?: string): {
  total_entities: number;
  total_tools: number;
  total_skills: number;
  embedded: number;
  models: Array<{ model: string; count: number }>;
} {
  const db = openCatalog();
  const total = (db.query('SELECT count(*) as c FROM entities').get() as { c: number }).c;
  const tools = (
    db.query("SELECT count(*) as c FROM entities WHERE kind='tool'").get() as { c: number }
  ).c;
  const skills = (
    db.query("SELECT count(*) as c FROM entities WHERE kind='skill'").get() as { c: number }
  ).c;
  const embedded = model
    ? (
        db.query('SELECT count(*) as c FROM entity_embeddings WHERE model = ?').get(model) as {
          c: number;
        }
      ).c
    : (db.query('SELECT count(*) as c FROM entity_embeddings').get() as { c: number }).c;
  const models = db
    .query('SELECT model, count(*) as count FROM entity_embeddings GROUP BY model')
    .all() as Array<{ model: string; count: number }>;
  return { total_entities: total, total_tools: tools, total_skills: skills, embedded, models };
}

export function allEmbeddings(
  model: string,
  kind?: EntityKind,
): Array<{ entity_id: number; vec: Float32Array }> {
  const sql = kind
    ? `SELECT ee.entity_id, ee.vec FROM entity_embeddings ee
       JOIN entities e ON e.id = ee.entity_id AND e.kind = ?
       WHERE ee.model = ?`
    : 'SELECT ee.entity_id, ee.vec FROM entity_embeddings ee WHERE ee.model = ?';
  const args: (string | number | null)[] = kind ? [kind, model] : [model];
  const rows = openCatalog()
    .query(sql)
    .all(...args) as Array<{ entity_id: number; vec: Buffer | Uint8Array }>;
  return rows.map((r) => {
    const u8 = Buffer.isBuffer(r.vec) ? r.vec : Buffer.from(r.vec);
    return {
      entity_id: r.entity_id,
      vec: new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4),
    };
  });
}

export function getEntitiesByIds(ids: number[]): EntityRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = openCatalog()
    .query(`SELECT * FROM entities WHERE id IN (${placeholders})`)
    .all(...ids) as EntityRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((i) => byId.get(i)).filter((r): r is EntityRow => !!r);
}

export function getToolsByIds(ids: number[]): ToolRow[] {
  return getEntitiesByIds(ids)
    .filter((e) => e.kind === 'tool')
    .map(entityToToolRow);
}
