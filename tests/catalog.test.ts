import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, unlinkSync } from 'node:fs';
import { catalogDbPath } from '../src/util/paths.ts';
import {
  closeCatalog,
  findTool,
  listServers,
  listTools,
  markServerError,
  openCatalog,
  replaceTools,
  searchTools,
} from '../src/catalog/store.ts';

function reset(): void {
  closeCatalog();
  const p = catalogDbPath();
  if (existsSync(p)) unlinkSync(p);
  if (existsSync(`${p}-shm`)) unlinkSync(`${p}-shm`);
  if (existsSync(`${p}-wal`)) unlinkSync(`${p}-wal`);
}

describe('catalog store', () => {
  beforeEach(() => reset());
  afterEach(() => reset());

  test('replaceTools inserts servers and tools, populates FTS', () => {
    openCatalog();
    replaceTools('s1', 'http', 'https://e.x', [
      { name: 't1', description: 'first tool', inputSchema: { properties: { a: { description: 'x' } } } },
      { name: 't2', description: 'second tool', inputSchema: { properties: { b: {} } } },
    ]);
    const servers = listServers();
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe('s1');
    expect(servers[0]?.tool_count).toBe(2);
    expect(servers[0]?.last_error).toBeNull();

    const tools = listTools('s1');
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['t1', 't2']);
  });

  test('replaceTools is idempotent (re-call replaces, no dupes)', () => {
    openCatalog();
    replaceTools('s1', 'http', null, [{ name: 't1', description: 'a' }]);
    replaceTools('s1', 'http', null, [
      { name: 't1', description: 'a (updated)' },
      { name: 't2', description: 'b' },
    ]);
    const tools = listTools('s1');
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.name === 't1')?.description).toBe('a (updated)');
  });

  test('findTool returns row or undefined', () => {
    openCatalog();
    replaceTools('s1', 'http', null, [{ name: 't1', description: 'a' }]);
    expect(findTool('s1', 't1')?.name).toBe('t1');
    expect(findTool('s1', 'nope')).toBeUndefined();
    expect(findTool('nope', 't1')).toBeUndefined();
  });

  test('markServerError records error without dropping existing tools', () => {
    openCatalog();
    replaceTools('s1', 'http', null, [{ name: 't1' }, { name: 't2' }]);
    markServerError('s1', 'http', null, 'connection refused');
    expect(listServers()[0]?.last_error).toBe('connection refused');
    expect(listTools('s1')).toHaveLength(2); // tools preserved
  });

  test('searchTools returns BM25-ranked results, name-weighted highest', () => {
    openCatalog();
    replaceTools('notion', 'http', null, [
      { name: 'create_page', description: 'Create a Notion page', inputSchema: { properties: { title: {} } } },
      { name: 'search', description: 'Semantic search across the workspace' },
      { name: 'fetch', description: 'Fetch a page by id' },
    ]);
    replaceTools('feishu', 'http', null, [
      { name: 'create_workitem', description: 'Create a Feishu work item' },
      { name: 'search_by_mql', description: 'Run MQL query' },
    ]);

    const r1 = searchTools('create page', { topN: 3 });
    expect(r1[0]?.name).toBe('create_page');
    expect(r1[0]?.server).toBe('notion');
    expect(r1[0]?.score).toBeLessThan(0); // FTS5 BM25 yields negative scores

    const r2 = searchTools('mql query', { topN: 3 });
    expect(r2[0]?.name).toBe('search_by_mql');

    const r3 = searchTools('feishu work item', { topN: 3 });
    expect(r3[0]?.name).toBe('create_workitem');
  });

  test('searchTools --server filter', () => {
    openCatalog();
    replaceTools('a', 'http', null, [{ name: 'create_thing', description: '...' }]);
    replaceTools('b', 'http', null, [{ name: 'create_thing', description: '...' }]);
    const r = searchTools('create thing', { topN: 5, server: 'b' });
    expect(r.every((t) => t.server === 'b')).toBe(true);
  });

  test('searchTools handles empty query and special chars without crashing', () => {
    openCatalog();
    replaceTools('a', 'http', null, [{ name: 'foo' }]);
    expect(() => searchTools('', { topN: 5 })).not.toThrow();
    expect(() => searchTools('()(*&^%$#"\'', { topN: 5 })).not.toThrow();
    expect(() => searchTools('AND OR NOT NEAR', { topN: 5 })).not.toThrow();
  });

  test('args_text indexing surfaces argument terms', () => {
    openCatalog();
    replaceTools('a', 'http', null, [
      {
        name: 'do_it',
        description: 'generic tool',
        inputSchema: {
          properties: {
            workspace_id: { description: 'the workspace ID to act on' },
          },
        },
      },
    ]);
    const r = searchTools('workspace ID', { topN: 5 });
    expect(r[0]?.name).toBe('do_it');
  });
});
