/**
 * Dead-file finder: builds a module import graph for src/ and reports files
 * that are never imported by any other file (excluding entry points).
 *
 * Usage: node scripts/find-dead.mjs
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve('src');
const ENTRY_POINTS = new Set(['main.tsx', 'App.tsx']);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

const files = walk(SRC);
const specifiers = new Map(); // file -> set of resolved module paths it imports

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.') && !spec.startsWith('@/')) return null; // bare package
  let base = spec.startsWith('@/') ? spec.replace('@/', SRC + '/') : spec;
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  const candidates = [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')];
  for (const c of candidates) {
    const abs = join(fromDir, c);
    if (statSync(abs, { throwIfNoEntry: false })?.isFile()) {
      return abs;
    }
  }
  return null;
}

for (const file of files) {
  const abs = file;
  const content = readFileSync(abs, 'utf8');
  const imported = new Set();
  const re = /(?:from\s+|import\()\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content))) {
    const target = resolveSpecifier(abs, m[1]);
    if (target) imported.add(target);
  }
  specifiers.set(abs, imported);
}

// Count how many files import each target.
const importers = new Map();
for (const [from, targets] of specifiers) {
  for (const t of targets) {
    if (!importers.has(t)) importers.set(t, []);
    importers.get(t).push(from);
  }
}

console.log('=== NEVER IMPORTED (candidates for deletion) ===');
for (const file of files) {
  const abs = file;
  if (ENTRY_POINTS.has(abs)) continue;
  if (!importers.has(abs)) {
    console.log(relative(SRC, abs));
  }
}
console.log('\n=== INDEX FILES THAT ARE NEVER IMPORTED (safe to ignore if registered elsewhere) ===');
