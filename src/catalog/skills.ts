import { readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Skill scanner.
 *
 * Scans a list of skill roots looking for `<root>/<name>/SKILL.md` files,
 * parses their YAML frontmatter, and returns a normalized record per skill.
 *
 * Default roots:
 *   - ~/.claude/skills/                 (user-level)
 *   - ~/.claude/skills-pool/            (the "pool" we want mcx to surface from)
 *   - ~/.claude/plugins/marketplaces/* /skills/   (plugin-level)
 *   - <cwd>/.claude/skills/             (project-level)
 *
 * We deliberately don't recurse arbitrarily — each root is one or two levels deep.
 *
 * Symlinks are resolved with realpath so we don't double-index when one root
 * symlinks into another (e.g. ~/.claude/skills/lark-im → ~/.agents/skills/lark-im).
 */

export interface ParsedSkill {
  /** Logical name from frontmatter `name:` field, or directory basename if missing. */
  name: string;
  /** First non-empty paragraph of the description scalar. */
  description: string;
  /** Extracted "trigger" phrases (when_to_use clauses, metadata leaf strings, etc.). */
  triggers: string;
  /** Absolute path to the SKILL.md file (after symlink resolution). */
  bodyPath: string;
  /** Size in bytes of the SKILL.md file. */
  bodySize: number;
  /** Which root this skill came from (the input path, not the realpath). */
  rootPath: string;
}

export interface ScanResult {
  rootPath: string;
  skills: ParsedSkill[];
  errors: string[];
}

export function defaultSkillRoots(cwd?: string): string[] {
  const home = homedir();
  const roots = [join(home, '.claude', 'skills'), join(home, '.claude', 'skills-pool')];
  if (cwd) roots.push(join(cwd, '.claude', 'skills'));
  // Plugin marketplaces — each marketplace dir may have its own skills/ subdir.
  return roots;
}

/**
 * Plugin skills sit under .claude/plugins/marketplaces/<plugin>/skills/<name>/SKILL.md.
 * We discover them with one extra readdir of the marketplaces dir.
 */
export async function discoverPluginSkillRoots(): Promise<string[]> {
  const home = homedir();
  const marketplaces = join(home, '.claude', 'plugins', 'marketplaces');
  try {
    const entries = await readdir(marketplaces, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillsDir = join(marketplaces, e.name, 'skills');
      try {
        const s = await stat(skillsDir);
        if (s.isDirectory()) out.push(skillsDir);
      } catch {
        /* not a plugin with skills */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Scan one root: look for `<root>/<name>/SKILL.md` (one level deep).
 * Returns parsed skills + any parse/IO errors (non-fatal — we keep going).
 */
export async function scanSkillRoot(rootPath: string): Promise<ScanResult> {
  const errors: string[] = [];
  const skills: ParsedSkill[] = [];
  const seenRealpaths = new Set<string>();

  let entries: Array<{ name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // Nonexistent root is normal (e.g. project .claude/skills/ never existed) — silent skip.
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { rootPath, skills, errors };
    }
    return { rootPath, skills, errors: [`readdir ${rootPath}: ${(e as Error).message}`] };
  }

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childPath = join(rootPath, e.name);

    let resolved: string;
    try {
      resolved = await realpath(childPath);
    } catch (err) {
      errors.push(`realpath ${childPath}: ${(err as Error).message}`);
      continue;
    }

    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch (err) {
      errors.push(`stat ${resolved}: ${(err as Error).message}`);
      continue;
    }
    if (!info.isDirectory()) continue;

    const skillFile = join(resolved, 'SKILL.md');
    let skillStat: Awaited<ReturnType<typeof stat>>;
    try {
      skillStat = await stat(skillFile);
    } catch {
      // No SKILL.md in this directory — skip silently.
      continue;
    }
    if (!skillStat.isFile()) continue;

    if (seenRealpaths.has(skillFile)) continue;
    seenRealpaths.add(skillFile);

    try {
      const text = await Bun.file(skillFile).text();
      const parsed = parseSkillMd(text, skillFile);
      skills.push({
        name: parsed.name ?? e.name,
        description: parsed.description ?? '',
        triggers: parsed.triggers ?? '',
        bodyPath: skillFile,
        bodySize: skillStat.size,
        rootPath,
      });
    } catch (err) {
      errors.push(`parse ${skillFile}: ${(err as Error).message}`);
    }
  }

  return { rootPath, skills, errors };
}

/**
 * Lightweight YAML frontmatter parser.
 *
 * We parse just enough to get name / description / version / metadata.* :
 *   - frontmatter delimited by `---` lines
 *   - top-level `key: value` pairs
 *   - quoted scalars (single or double)
 *   - simple block scalars (`description: "long string"`)
 *   - nested objects under `metadata:` collected as flat string for triggers
 *
 * If you need full YAML, swap `js-yaml` in. For our skill files this is plenty.
 */
export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  triggers?: string;
}

export function parseSkillMd(text: string, sourcePath: string): ParsedFrontmatter {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!m) {
    // No frontmatter — fall back to filename-based name + first H1 as description.
    const dir = basename(dirname(sourcePath));
    return { name: dir };
  }
  const fm = m[1];
  if (!fm) {
    return { name: basename(dirname(sourcePath)) };
  }

  const fields = parseYamlIsh(fm);
  const name = stringField(fields, 'name') ?? basename(dirname(sourcePath));
  const description = stringField(fields, 'description');
  const triggers = collectTriggers(fields, description);
  return {
    name,
    ...(description !== undefined && { description }),
    ...(triggers && { triggers }),
  };
}

type YamlField = { key: string; value: string; depth: number };

/** Parse the simple subset of YAML our skills use into a flat list. */
function parseYamlIsh(src: string): YamlField[] {
  const out: YamlField[] = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? (indentMatch[1]?.length ?? 0) : 0;
    const trimmed = line.slice(indent);
    const kv = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1] ?? '';
    let val = kv[2] ?? '';

    // Strip quotes from scalar.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }

    // If the value is empty, this might be the start of a block (object/array).
    // We accumulate everything indented deeper than this line as the "value".
    if (!val) {
      const collect: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        if (!next.trim()) {
          j++;
          continue;
        }
        const nextIndentMatch = next.match(/^(\s*)/);
        const nextIndent = nextIndentMatch ? (nextIndentMatch[1]?.length ?? 0) : 0;
        if (nextIndent <= indent) break;
        collect.push(next.trim());
        j++;
      }
      val = collect.join(' ');
      out.push({ key, value: val, depth: indent });
      i = j;
      continue;
    }

    out.push({ key, value: val, depth: indent });
    i++;
  }
  return out;
}

function stringField(fields: YamlField[], key: string): string | undefined {
  const f = fields.find((x) => x.depth === 0 && x.key === key);
  return f?.value;
}

/**
 * Triggers heuristic: pull anything that helps semantic search match user intent.
 *   - All "当 X 时 / when X" clauses from description
 *   - All metadata leaf string values (workspace, requires.bins, mechanism_doc, etc.)
 *   - Skill `version` and any custom keys
 */
function collectTriggers(fields: YamlField[], description?: string): string {
  const parts: string[] = [];

  if (description) {
    // Capture "当...时", "当...使用", "when ... use", "trigger when ..." style hints.
    const cn = description.match(/当[^,;,。\n]{2,80}(?:时|使用|触发)/g);
    if (cn) parts.push(...cn);
    const en = description.match(/(?:when|trigger|use)\s+[^,.;\n]{3,80}/gi);
    if (en) parts.push(...en);
  }

  // Pull every non-zero-depth leaf — that's metadata.* / nested bits.
  for (const f of fields) {
    if (f.depth === 0) continue;
    if (!f.value) continue;
    parts.push(f.value);
  }

  return parts.join(' ').slice(0, 4000);
}

/** Build the text we embed for a skill (used by embed.ts via embeddableText). */
export function skillEmbeddableText(s: ParsedSkill): string {
  return [s.name, s.description, s.triggers].filter(Boolean).join('\n').slice(0, 4000);
}
