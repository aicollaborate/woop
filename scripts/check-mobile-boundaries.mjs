#!/usr/bin/env node
// Prevent the mobile bundle from growing back into the desktop application.
// This is deliberately a small dependency-free import scanner: CI needs a
// clear error before a desktop-only feature reaches an iOS/Android build.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../app/flowix-web', import.meta.url));
const MOBILE_ROOTS = [
  'app/mobile/',
  'features/editor/mobile/',
  'entrypoints/mobile.tsx',
];
const DESKTOP_FEATURE_PREFIXES = [
  '@features/agent/',
  '@features/shell',
  '@features/preferences/',
  '@features/shortcuts/',
  '@features/theme',
];
const FROM_RE = /\b(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, files);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.(ts|tsx)$/.test(entry)) files.push(path);
  }
  return files;
}

function isMobileFile(path) {
  const file = relative(ROOT, path).replaceAll('\\', '/');
  return MOBILE_ROOTS.some((root) => file === root || file.startsWith(root));
}

const violations = [];
for (const file of walk(ROOT).filter(isMobileFile)) {
  const display = relative(ROOT, file).replaceAll('\\', '/');
  const source = readFileSync(file, 'utf8');
  const imports = [];
  for (const expression of [FROM_RE, DYNAMIC_RE]) {
    expression.lastIndex = 0;
    let match;
    while ((match = expression.exec(source))) imports.push(match[1]);
  }

  for (const specifier of imports) {
    const desktopApp = specifier === '@app/app' || specifier.startsWith('@app/tab-window/');
    const desktopClient = specifier === '@platform/tauri/client' || specifier.startsWith('@platform/tauri/client/');
    const desktopFeature = DESKTOP_FEATURE_PREFIXES.some((prefix) => specifier === prefix || specifier.startsWith(prefix));
    if (desktopApp || desktopClient || desktopFeature) {
      violations.push(`${display}: ${specifier}`);
    }
  }
}

if (violations.length) {
  console.error(`\n❌ 移动端边界违规 (${violations.length}):`);
  for (const violation of violations) console.error(`  ${violation}`);
  console.error('\n移动端只能使用 mobile-client、移动 UI 与明确共享的 features/shared 模块。\n');
  process.exit(1);
}

console.log('✓ 移动端边界检查通过');
