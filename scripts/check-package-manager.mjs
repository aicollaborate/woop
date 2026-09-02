#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = resolve(root, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const expectedPackageManager = 'npm@10.8.2';
const forbiddenRootFiles = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'];
const failures = [];

if (packageJson.packageManager !== expectedPackageManager) {
  failures.push(
    `package.json.packageManager must be ${expectedPackageManager}, got ${packageJson.packageManager ?? 'missing'}`,
  );
}

if (!existsSync(resolve(root, 'package-lock.json'))) {
  failures.push('root package-lock.json is missing');
}

for (const file of forbiddenRootFiles) {
  if (existsSync(resolve(root, file))) {
    failures.push(`${file} must not exist in the npm-managed root project`);
  }
}

if (failures.length > 0) {
  console.error(`\n❌ Package manager policy failed\n\n${failures.map((failure) => `  ${failure}`).join('\n')}\n`);
  process.exit(1);
}

console.log(`✓ Root package manager policy passed (${expectedPackageManager})`);
