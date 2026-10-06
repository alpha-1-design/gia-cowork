#!/usr/bin/env node
/**
 * Regenerate the provider table in README.md from `src/services/providerInfo.ts`.
 *
 * The table is deliberately not hand-written: this project has already hit the
 * "list duplicated in two places, then silently drifts" bug more than once. The
 * source of truth is `PROVIDER_INFO`; this script mirrors it into the README
 * between marker comments.
 *
 * Usage: node scripts/generate-provider-table.mjs
 * Exits non-zero if the markers are missing or no rows were parsed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'src', 'services', 'providerInfo.ts');
const README = join(root, 'README.md');

const BEGIN = '<!-- BEGIN GENERATED PROVIDERS -->';
const END = '<!-- END GENERATED PROVIDERS -->';

/** Pull the structured entries out of PROVIDER_INFO without a TS loader. */
function parseEntries(source) {
  const start = source.indexOf('export const PROVIDER_INFO');
  if (start === -1) throw new Error('PROVIDER_INFO not found in providerInfo.ts');
  const body = source.slice(start);

  const entries = [];
  const re = /^\s{2}(?:'([^']+)'|([A-Za-z0-9_-]+)):\s*\{\s*company:\s*'((?:[^'\\]|\\.)*)',\s*description:\s*'((?:[^'\\]|\\.)*)',\s*docsUrl:\s*'((?:[^'\\]|\\.)*)'\s*\},/gm;
  let m;
  while ((m = re.exec(body))) {
    const id = m[1] || m[2];
    entries.push({
      id,
      company: m[3],
      description: m[4],
      docsUrl: m[5],
    });
  }
  return entries;
}

function markdownTable(entries) {
  const rows = entries.map(e => {
    const link = e.docsUrl ? `[Get a key](${e.docsUrl})` : 'Local — no key';
    return `| \`${e.id}\` | ${e.company} | ${e.description} | ${link} |`;
  });
  return [
    '| Provider | Company | Description | Get a key |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function main() {
  const source = readFileSync(SRC, 'utf8');
  const entries = parseEntries(source);
  if (!entries.length) throw new Error('parsed 0 provider entries — regex no longer matches');

  const readme = readFileSync(README, 'utf8');
  const beginAt = readme.indexOf(BEGIN);
  const endAt = readme.indexOf(END);
  if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
    throw new Error(`README is missing the ${BEGIN} / ${END} markers`);
  }

  const updated =
    readme.slice(0, beginAt + BEGIN.length) +
    '\n\n' + markdownTable(entries) + '\n\n' +
    readme.slice(endAt);

  writeFileSync(README, updated);
  console.log(`[providers] regenerated README table with ${entries.length} providers`);
}

main();