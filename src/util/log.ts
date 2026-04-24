/**
 * Stderr-only logger. JSON output goes to stdout untouched.
 */

export const log = {
  info: (msg: string, ...rest: unknown[]) => {
    process.stderr.write(`${msg}${rest.length ? ` ${formatRest(rest)}` : ''}\n`);
  },
  warn: (msg: string, ...rest: unknown[]) => {
    process.stderr.write(`warn: ${msg}${rest.length ? ` ${formatRest(rest)}` : ''}\n`);
  },
  error: (msg: string, ...rest: unknown[]) => {
    process.stderr.write(`error: ${msg}${rest.length ? ` ${formatRest(rest)}` : ''}\n`);
  },
  debug: (msg: string, ...rest: unknown[]) => {
    if (process.env.MCX_DEBUG) {
      process.stderr.write(`debug: ${msg}${rest.length ? ` ${formatRest(rest)}` : ''}\n`);
    }
  },
};

function formatRest(rest: unknown[]): string {
  return rest
    .map((r) => {
      if (typeof r === 'string') return r;
      try {
        return JSON.stringify(r);
      } catch {
        return String(r);
      }
    })
    .join(' ');
}
