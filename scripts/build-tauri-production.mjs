import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const platformArgIndex = process.argv.indexOf("--platform");
const targetPlatform =
  platformArgIndex >= 0 ? process.argv[platformArgIndex + 1] : process.platform;

// macOS 发版构建 ARM (aarch64) 与 Intel (x86_64) 两个独立 DMG。
// target 的 bundle 落到 $CARGO_TARGET_DIR/<triple>/release/bundle/；sidecar
// 也按 target 分别准备，避免把错误架构混入正式包。
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

if (!process.env.FLOWIX_DSH_UPDATE_PUBLIC_KEY?.trim()) {
  process.env.FLOWIX_DSH_UPDATE_PUBLIC_KEY = run(
    "node",
    ["scripts/derive-dsh-public-key.mjs"],
    { capture: true },
  );
}

if (targetPlatform === "darwin") {
  run("npm", ["run", "cli:build:macos"]);
} else {
  run("npm", ["run", "cli:build"]);
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
// 给两个 macOS target 的 tauri build 复用；其它平台跑一次无 --target。
const tauriTargets = targetPlatform === "darwin" ? MACOS_TARGETS : [null];

for (const target of tauriTargets) {
  const buildArgs = ["build", "--config", configPath];
  if (target) {
    buildArgs.push("--target", target);
  }
  run("tauri", buildArgs);
}
