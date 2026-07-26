#!/usr/bin/env node
// scripts/check-layer-boundaries.mjs
//
// 强制前端层级边界 (platform < lib/shared < features < app):
//   - shared / lib / platform 不得 import @features/* 或 @app/*
//     (低层不反向依赖高层; @/types 中性层任意方可用)
//   - features / shared / lib 不得直接 import @tauri-apps/*
//     (必须走 @platform/tauri/* 封装; platform 是 Tauri 适配层故豁免;
//      app 是组合根故豁免; 测试文件豁免 ── vi.mock 底层模块是合法用法)
//
// 设计: 与 CI "先保证绿灯, 再逐步收紧" 哲学一致。无新依赖, 纯静态扫描。
// 防"9 处反向依赖"类问题回退 ── 见 Flowix 技术债务清单 P0 前端结构。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../app/flowix-web', import.meta.url));

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.build') continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(p);
  }
  return acc;
}

const files = walk(ROOT);
const violations = [];

// 静态 import/export ... from '...' (含多行)
const FROM_RE = /\b(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g;
// 动态 import('...')
const DYN_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const rel = (p) => relative(ROOT, p);
const isTest = (p) => /\.(test|spec)\.(ts|tsx)$/.test(p);
const isLowLayer = (layer) => layer === 'shared' || layer === 'lib' || layer === 'platform';
const isMidLayer = (layer) => layer === 'features' || layer === 'shared' || layer === 'lib';

for (const file of files) {
  const r = rel(file);
  const src = readFileSync(file, 'utf8');
  const layer = r.split('/')[0];
  const specs = [];
  for (const re of [FROM_RE, DYN_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) specs.push(m[1]);
  }

  for (const spec of specs) {
    // Rule A: 低层不得反向依赖 features / app
    if (isLowLayer(layer) && (spec.startsWith('@features/') || spec.startsWith('@app/'))) {
      violations.push(`${r}: 反向依赖 ${spec}  (低层 ${layer} 不得 import features/app)`);
    }
    // Rule B: features/shared/lib 不得直接 import @tauri-apps/* (非测试)
    if (!isTest(file) && isMidLayer(layer) && spec.startsWith('@tauri-apps/')) {
      violations.push(`${r}: 直接 import ${spec}  (须走 @platform/tauri/* 封装)`);
    }
  }
}

if (violations.length) {
  console.error(`\n❌ 层级边界违规 (${violations.length}):`);
  for (const v of violations) console.error('  ' + v);
  console.error('\n规则: platform/lib/shared 不反向依赖 features/app; features/lib/shared 不直引 @tauri-apps/* (走 @platform/tauri/*)。');
  console.error('例外: platform 与 app 豁免 @tauri-apps; 测试文件豁免 @tauri-apps (vi.mock)。\n');
  process.exit(1);
}
console.log(`✓ 层级边界检查通过 (扫描 ${files.length} 文件)`);
