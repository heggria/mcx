#!/usr/bin/env bun
import { Command } from 'commander';
import { registerAuthCommand } from './commands/auth.ts';
import { registerCallCommand } from './commands/call.ts';
import { registerEmbedCommand } from './commands/embed.ts';
import { registerIndexCommand } from './commands/index-cmd.ts';
import { registerListCommand } from './commands/list.ts';
import { registerReceiptsCommand } from './commands/receipts.ts';
import { registerSearchCommand } from './commands/search.ts';

const program = new Command();

program
  .name('mcx')
  .description('MCP Tools CLI — semantic search, call, and govern MCP servers')
  .version('0.1.0')
  .option('--json', 'force JSON envelope output')
  .option('--config <path>', 'override backends.toml path');

registerIndexCommand(program);
registerEmbedCommand(program);
registerSearchCommand(program);
registerCallCommand(program);
registerListCommand(program);
registerAuthCommand(program);
registerReceiptsCommand(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`mcx: ${(err as Error).message ?? String(err)}\n`);
  process.exit(1);
});
