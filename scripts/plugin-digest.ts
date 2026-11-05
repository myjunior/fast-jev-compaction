// Computes the `pluginDigests` value Claude Code checks for an org-delivered
// plugin folder: sha256 over every regular file, sorted by path (UTF-16 code
// units), each as "f PATH\0BYTE-LENGTH\0BYTES". Usage: bun scripts/plugin-digest.ts [dir]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT_EXCLUDED = new Set([
  '.git',
  '.in_use',
  '.orphaned_at',
  '.claude-plugin-link',
  '.links_materialized',
]);

function listFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split(sep).join('/');
    if (dir === root && ROOT_EXCLUDED.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`symbolic link ${rel} proves nothing`);
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) out.push(rel);
  }
}

export function pluginDigest(root: string): string {
  const files: string[] = [];
  listFiles(root, root, files);
  const hash = createHash('sha256');
  for (const rel of files.toSorted()) {
    const bytes = readFileSync(join(root, rel));
    if (bytes.length !== statSync(join(root, rel)).size) throw new Error(`${rel} changed`);
    hash.update(`f ${rel}\x00${bytes.length}\x00`);
    hash.update(bytes);
  }
  return `sha256-${hash.digest('base64')}`;
}

console.log(pluginDigest(process.argv[2] ?? 'plugin'));
