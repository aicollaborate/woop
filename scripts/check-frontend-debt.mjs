#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../app/flowix-web', import.meta.url));
const LOGGER_FILE = join(ROOT, 'lib/logger.ts');

// Ratchets: lower these numbers as legacy debt is removed. Never raise them to
// make CI green; new code must use typed boundaries and createLogger().
const MAX_EXPLICIT_ANY = 0;
const MAX_DIRECT_CONSOLE_CALLS = 106;

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function sourceKind(file) {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function isDirectConsoleCall(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  if (ts.isPropertyAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === 'console';
  }
  if (ts.isElementAccessExpression(expression)) {
    return ts.isIdentifier(expression.expression) && expression.expression.text === 'console';
  }
  return false;
}

function location(source, node) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${relative(ROOT, source.fileName)}:${line + 1}:${character + 1}`;
}

const explicitAnyLocations = [];
const directConsoleLocations = [];
const files = walk(ROOT);

for (const file of files) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    sourceKind(file),
  );

  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      explicitAnyLocations.push(location(source, node));
    }
    if (file !== LOGGER_FILE && isDirectConsoleCall(node)) {
      directConsoleLocations.push(location(source, node));
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
}

const failures = [];
if (explicitAnyLocations.length > MAX_EXPLICIT_ANY) {
  failures.push(
    `显式 any ${explicitAnyLocations.length} > ${MAX_EXPLICIT_ANY}:\n` +
      explicitAnyLocations.map((item) => `  ${item}`).join('\n'),
  );
}
if (directConsoleLocations.length > MAX_DIRECT_CONSOLE_CALLS) {
  failures.push(
    `直接 console 调用 ${directConsoleLocations.length} > ${MAX_DIRECT_CONSOLE_CALLS}:\n` +
      directConsoleLocations.map((item) => `  ${item}`).join('\n'),
  );
}

if (failures.length > 0) {
  console.error(`\n❌ 前端债务门禁失败\n\n${failures.join('\n\n')}\n`);
  process.exit(1);
}

console.log(
  `✓ 前端债务门禁通过 (显式 any: ${explicitAnyLocations.length}/${MAX_EXPLICIT_ANY}, ` +
    `直接 console: ${directConsoleLocations.length}/${MAX_DIRECT_CONSOLE_CALLS})`,
);
