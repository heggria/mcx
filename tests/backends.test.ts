import { describe, expect, test } from 'bun:test';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackendsFileSchema, loadBackends } from '../src/config/backends.ts';
import { parse } from 'smol-toml';

describe('backends.toml schema', () => {
  test('parses valid stdio backend', () => {
    const r = BackendsFileSchema.safeParse(
      parse(`
        [backend.foo]
        type = "stdio"
        command = "npx"
        args = ["foo-mcp"]
      `),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      const foo = r.data.backend.foo;
      expect(foo?.type).toBe('stdio');
      if (foo?.type === 'stdio') {
        expect(foo.command).toBe('npx');
        expect(foo.args).toEqual(['foo-mcp']);
        expect(foo.env).toEqual({});
      }
    }
  });

  test('parses http backend with header auth', () => {
    const r = BackendsFileSchema.safeParse(
      parse(`
        [backend.bar]
        type = "http"
        url = "https://example.com/mcp"
        [backend.bar.auth]
        kind = "header"
        name = "X-Foo-Token"
      `),
    );
    expect(r.success).toBe(true);
    if (r.success) {
      const bar = r.data.backend.bar;
      if (bar?.type === 'http') {
        expect(bar.url).toBe('https://example.com/mcp');
        expect(bar.auth).toEqual({ kind: 'header', name: 'X-Foo-Token' });
      }
    }
  });

  test('parses sse backend with bearer auth', () => {
    const r = BackendsFileSchema.safeParse(
      parse(`
        [backend.baz]
        type = "sse"
        url = "https://example.com/sse"
        [backend.baz.auth]
        kind = "bearer"
      `),
    );
    expect(r.success).toBe(true);
  });

  test('rejects invalid backend name (contains spaces)', () => {
    const r = BackendsFileSchema.safeParse({
      backend: {
        'bad name': { type: 'stdio', command: 'x', args: [], env: {} },
      },
    });
    expect(r.success).toBe(false);
  });

  test('rejects unknown transport type', () => {
    const r = BackendsFileSchema.safeParse({
      backend: { foo: { type: 'magic', url: 'https://x.com' } },
    });
    expect(r.success).toBe(false);
  });

  test('rejects http backend without url', () => {
    const r = BackendsFileSchema.safeParse({
      backend: { foo: { type: 'http' } },
    });
    expect(r.success).toBe(false);
  });

  test('loadBackends throws config_missing for nonexistent file', () => {
    expect(() => loadBackends('/nonexistent/path/backends.toml')).toThrow(
      /backends.toml not found/,
    );
  });

  test('loadBackends throws config_invalid on bad toml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcx-test-'));
    const f = join(dir, 'bad.toml');
    writeFileSync(
      f,
      `
[backend.x]
type = "stdio"
# missing command
`,
    );
    try {
      expect(() => loadBackends(f)).toThrow(/validation failed/);
    } finally {
      unlinkSync(f);
    }
  });

  test('round-trip: example config from this repo loads cleanly', () => {
    const file = loadBackends('./examples/backends.toml');
    const names = Object.keys(file.backend).sort();
    expect(names).toContain('chrome-devtools');
    expect(names).toContain('notion');
    expect(file.backend['chrome-devtools']?.type).toBe('stdio');
  });
});
