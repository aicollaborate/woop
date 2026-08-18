import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const platformArgIndex = process.argv.indexOf("--platform");
const targetPlatform =
  platformArgIndex >= 0 ? process.argv[platformArgIndex + 1] : process.platform;

// macOS 发版走方案 B: ARM (aarch64) + Intel (x86_64) 各出一个独立 DMG。
// 两个 target 的 bundle 落到各自的 $CARGO_TARGET_DIR/<triple>/release/bundle/,
// 互不覆盖; sidecar 也需要两个 triple 的 binary 都在 binaries/ (Tauri --target
// 模式按当前 build target 挑对应 sidecar, 缺一个就 fallback 失败)。
// 其它平台单架构 (host), 走 cli:build 单 host + 一次 tauri build。
const MACOS_TARGETS = ["aarch64-apple-darwin", "x86_64-apple-darwin"];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: options.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    shell: process.platform === "win32",
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout?.trim();
}

if (targetPlatform === "darwin") {
  run("npm", ["run", "cli:build:macos"]);
  run("npm", ["run", "dsh:build:macos"]);
} else {
  run("npm", ["run", "cli:build"]);
  if (targetPlatform === "win32") {
    run("npm", ["run", "dsh:build:win"]);
  } else {
    run("npm", ["run", "dsh:build"]);
  }
}

const configPath = run(
  "node",
  ["scripts/prepare-tauri-production-config.mjs", "--platform", targetPlatform],
  { capture: true },
);

if (!configPath) {
  throw new Error("Production config generator did not return a config path.");
}

// config 跟 target 无关 (signing identity / entitlements 通用), 生成一次,
// 给每个 target 的 tauri build 复用。macOS 循环两个 target 出两个 DMG;
// 其它平台跑一次无 --target (host)。
const tauriTargets = targetPlatform === "darwin" ? MACOS_TARGETS : [null];

for (const target of tauriTargets) {
  const buildArgs = ["build", "--config", configPath];
  if (target) {
    buildArgs.push("--target", target);
  }
  run("tauri", buildArgs);
}
