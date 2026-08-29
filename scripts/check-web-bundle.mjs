#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = resolve(ROOT, '.build/web-dist');
const indexPath = join(DIST, 'index.html');
const html = readFileSync(indexPath, 'utf8');
const failures = [];

const manifestPath = join(DIST, '.vite', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// All three lazy roots render concurrently in the default desktop window.
// Follow their static imports recursively; checking index.html alone misses
// Vite's runtime __vitePreload dependency graph.
const desktopStartupRoots = [
  'index.html',
  'features/shell/index.ts',
  'app/main-window-effects.tsx',
  'app/agent-window-effects.tsx',
];
const startupManifestKeys = new Set();

function visitStaticImports(key) {
  if (startupManifestKeys.has(key)) return;
  const chunk = manifest[key];
  if (!chunk) {
    failures.push(`manifest has no desktop startup root/import: ${key}`);
    return;
  }
  startupManifestKeys.add(key);
  for (const importedKey of chunk.imports ?? []) {
    visitStaticImports(importedKey);
  }
}

for (const root of desktopStartupRoots) visitStaticImports(root);

let startupRawBytes = 0;
let startupGzipBytes = 0;
for (const key of startupManifestKeys) {
  const chunk = manifest[key];
  if (!chunk?.file?.endsWith('.js')) continue;
  const bytes = readFileSync(resolve(DIST, chunk.file));
  startupRawBytes += bytes.byteLength;
  startupGzipBytes += gzipSync(bytes).byteLength;
}

// Budgets track the desktop startup graph (`index.html` + `features/shell/` +
// `app/main-window-effects.tsx` + `app/agent-window-effects.tsx`).
//
// Gzip budget was raised from 850 KB to 900 KB (Feb 2026) to absorb the agent
// history/thread reconciliation refactor (history-sync engine, projection
// slices, thread lifecycle). The agent subsystem adds ~4 KB gzip to the
// startup graph on top of the long-running ~849 KB baseline; future agent
// growth should either stay inside this 50 KB headroom or move reconcilers
// behind a dynamic import (see `thread-history-slice.ts` for the pattern).
const STARTUP_RAW_BUDGET = 3_000_000;
const STARTUP_GZIP_BUDGET = 900_000;
if (startupRawBytes > STARTUP_RAW_BUDGET) {
  failures.push(`desktop startup JavaScript is ${startupRawBytes} bytes, budget is ${STARTUP_RAW_BUDGET}`);
}
if (startupGzipBytes > STARTUP_GZIP_BUDGET) {
  failures.push(`desktop startup gzip is ${startupGzipBytes} bytes, budget is ${STARTUP_GZIP_BUDGET}`);
}

const startupGrammarKeys = [...startupManifestKeys].filter((key) =>
  key.includes('node_modules/@shikijs/langs/'),
);
if (startupGrammarKeys.length > 0) {
  failures.push(`Shiki grammars entered desktop startup: ${startupGrammarKeys.join(', ')}`);
}

const optionalHeavyChunks = ['mermaid', 'shiki', 'katex', 'cytoscape'];
for (const name of optionalHeavyChunks) {
  if (new RegExp(`modulepreload[^>]+${name}`, 'i').test(html)) {
    failures.push(`optional ${name} chunk is preloaded by index.html`);
  }
}

function referencedAsset(pattern, label, maxBytes) {
  const match = html.match(pattern);
  if (!match) {
    failures.push(`index.html has no ${label} asset`);
    return;
  }
  const path = resolve(DIST, match[1]);
  const bytes = statSync(path).size;
  if (bytes > maxBytes) {
    failures.push(`${label} is ${bytes} bytes, budget is ${maxBytes}`);
  }
}

referencedAsset(/<script[^>]+src="([^"]+\.js)"/, 'entry JavaScript', 700_000);
referencedAsset(/<link[^>]+href="([^"]+\.css)"/, 'entry CSS', 260_000);

const interFonts = readdirSync(join(DIST, 'assets')).filter((name) =>
  /^inter-.*\.(?:woff2?|ttf)$/i.test(name),
);
if (interFonts.length > 12) {
  failures.push(`Inter emits ${interFonts.length} font files, budget is 12`);
}
if (interFonts.some((name) => !name.endsWith('.woff2'))) {
  failures.push(`legacy Inter font formats emitted: ${interFonts.map(basename).join(', ')}`);
}

if (failures.length) {
  console.error(`\n❌ Web bundle budget failed\n\n${failures.map((item) => `  ${item}`).join('\n')}\n`);
  process.exit(1);
}

console.log(
  `✓ Web bundle budget passed (startup JS: ${startupRawBytes} raw / ${startupGzipBytes} gzip; Inter fonts: ${interFonts.length}/12)`,
);
