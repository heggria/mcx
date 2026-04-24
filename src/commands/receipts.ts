import type { Command } from 'commander';
import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { auditLogPath } from '../util/paths.ts';
import { withEnvelope } from '../envelope.ts';
import { callId } from '../util/ids.ts';

/**
 * Read the last N lines of audit.jsonl efficiently:
 * seek to EOF, read backwards in 8KB chunks until we have N newlines, then split + parse.
 * For mcx-scale logs (~100 ops/day), this is overkill but it's also cheap.
 */
function tailJsonl(path: string, n: number): unknown[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const chunkSize = 8 * 1024;
    let buffer = Buffer.alloc(0);
    let pos = size;
    let lineCount = 0;
    while (pos > 0 && lineCount <= n) {
      const readBytes = Math.min(chunkSize, pos);
      pos -= readBytes;
      const chunk = Buffer.alloc(readBytes);
      readSync(fd, chunk, 0, readBytes, pos);
      buffer = Buffer.concat([chunk, buffer]);
      lineCount = (buffer.toString('utf8').match(/\n/g) || []).length;
    }
    const lines = buffer.toString('utf8').split('\n').filter((l) => l.length > 0);
    return lines
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { _malformed: l };
        }
      });
  } finally {
    closeSync(fd);
  }
}

export function registerReceiptsCommand(program: Command): void {
  const receipts = program.command('receipts').description('view audit log');

  receipts
    .command('tail')
    .description('show the last N audit records')
    .option('-n, --lines <n>', 'how many lines', '20')
    .option('--op <op>', 'filter to one op (e.g. search, call, index)')
    .action(async (opts: { lines: string; op?: string }) => {
      const id = callId();
      const root = program.opts<{ json?: boolean }>();
      const n = Math.max(1, Math.min(10000, Number(opts.lines)));
      await withEnvelope('receipts.tail', id, root.json, async () => {
        let records = tailJsonl(auditLogPath(), n);
        if (opts.op) {
          records = records.filter((r) => (r as { op?: string }).op === opts.op);
        }
        return { count: records.length, records };
      });
    });
}
