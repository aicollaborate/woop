import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeSpec } from "../protocol/v1.ts";
import { disabledPluginKeys } from "./plugin-directory.ts";
import { applyPluginDisables } from "./plugin-composition.ts";
import { SIDECAR_BUILD_ID, SIDECAR_BUILD_ID_ENV } from "../build-meta.ts";
import { mergeFlowixProfileBundles } from "./profile-manifest.ts";
import DEFAULT_CORDIS_CONFIG from "../../config/flowix.cordis.yml";
import STANDARD_PRESET from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml";
import STANDARD_PRESET_META from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/standard/preset.yml";
import CODE_PRESET from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/code/agent.cordis.yml";
import CODE_PRESET_META from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/code/preset.yml";
import MINIMAL_PRESET from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/minimal/agent.cordis.yml";
import MINIMAL_PRESET_META from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/minimal/preset.yml";
import CORDIS_PRESET from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/cordis/agent.cordis.yml";
import CORDIS_PRESET_META from "../../vendor/deepseek-harness/apps/cli/config/agent-presets/cordis/preset.yml";

const PASSTHROUGH = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "HOME",
  "USERPROFILE",
  "NODE_USE_ENV_PROXY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export function runtimeEnvironment(spec: RuntimeSpec): NodeJS.ProcessEnv {
  ensureFlowixProfile();
  const disabled = disabledPluginKeys();
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of [
    "DSH_HOME",
    "DSH_SETTINGS_PATH",
    "DSH_CREDENTIALS_PATH",
  ] as const) {
    const value = process.env[key];
    if (value !== undefined && value !== "") env[key] = value;
  }
  env.DSH_CWD = spec.cwd;
  // The Flowix composition is a normal DSH profile overlay. The profile owns
  // the bridge plugin; the base cordis config owns the DSH runtime roster.
  env.DSH_PROFILE = "flowix";
  env.FLOWIX_DSH_SDK_SERVER = join(hostRoot(), "runtime", "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server", "lib", "index.js");
  // Flowix owns the harness home. Point the harness's own resolver (skills,
  // AGENTS.md, storage domains) at the single dsh root instead of ~/.dsh.
  const dshHome = process.env.FLOWIX_DSH_HOME ?? process.env.DSH_HOME;
  if (dshHome !== undefined && dshHome !== "") {
    env.DSH_HOME = dshHome;
    env.DSH_PROFILE_DIR = join(dshHome, "profiles", "flowix");
  }
  // The vendored sandbox consumes this as a write-root list. Keep the JSON
  // boundary explicit so paths never become shell syntax or prompt text.
  env.DSH_WORKSPACE_ROOTS = JSON.stringify([
    ...new Set([spec.cwd, ...spec.workspacePaths]),
  ]);
  // Provider route, endpoint, protocol, model, and credentials are supplied
  // through the official SDK/settings seam. They are deliberately not
  // mirrored into process.env or a Flowix-specific provider alias.
  env.DSH_PERMISSION_MODE = spec.permissionMode;
  env.DSH_AGENT_PRESET = spec.agentPreset;
  env.DSH_AGENT_PRESET_ROOT = presetRootPath(disabled);
  // Match the official Harness layout: the persistence plugin itself owns
  // the project/session-id directories beneath <DSH_HOME>/sessions.
  env.DSH_SESSION_ROOT = sessionBaseRoot();
  env.DSH_CORDIS_CONFIG = cordisConfigPath(disabled);
  const mcpCli = flowixCliPath();
  if (mcpCli !== undefined) env.FLOWIX_DSH_MCP_CLI = mcpCli;
  // Use the official bundled plugin in both dev and packaged runtimes. A
  // source-tree .ts URL works with tsx but cannot be loaded from the SEA
  // snapshot, while the runtime closure owns the built settings-file plugin.
  env.DSH_SETTINGS_MODULE = "@deepseek-ai/dsh-settings-file";
  return env;
}

/**
 * Install the shipped Flowix profile bundle into DSH_HOME. The source bundle
 * is distributed beside dsh-host under `profile/flowix`; it is not compiled
 * into the host and the host does not synthesize plugin source anymore.
 *
 * DSH's profile loader intentionally resolves bundles from the installation
 * first and the profile directory second. Since Flowix's durable DSH_HOME is
 * user-owned and separate from the downloaded archive, copying the packaged
 * profile into DSH_HOME is the install boundary that lets the official DSH
 * loader see a normal profile bundle. Only the Flowix-owned bundle files are
 * refreshed; user profile fields and patch layers remain intact.
 */
export function ensureFlowixProfile(): void {
  const home =
    process.env.FLOWIX_DSH_HOME ??
    process.env.DSH_HOME ??
    (process.env.HOME === undefined ? undefined : join(process.env.HOME, ".dsh"));
  if (home === undefined || home.trim() === "") return;
  const sourceDir = flowixProfileSourceDir();
  if (sourceDir === undefined) {
    throw new Error(
      "Flowix DSH profile bundle is missing; reinstall the DSH package with its profile/flowix directory",
    );
  }
  const profileDir = join(home, "profiles", "flowix");
  const memorySourceDir = flowixMemorySourceDir();
  if (memorySourceDir === undefined) {
    throw new Error("Flowix DSH memory bundle is missing; reinstall the DSH package");
  }
  copyProfilePackage(memorySourceDir, join(profileDir, "node_modules", "dsh-flowix-memory"));
  const bridgeSourceDir = join(sourceDir, "node_modules", "@flowix", "dsh-flowix-bridge");
  if (!existsSync(join(bridgeSourceDir, "package.json"))) {
    throw new Error("Flowix DSH bridge bundle is missing; reinstall the DSH package");
  }
  copyProfilePackage(bridgeSourceDir, join(profileDir, "node_modules", "@flowix", "dsh-flowix-bridge"));
  const installedBridgePatch = join(profileDir, "node_modules", "@flowix", "dsh-flowix-bridge", "cordis.patch.yml");
  const sdkServerEntry = pathToFileURL(join(hostRoot(), "runtime", "node_modules", "@deepseek-ai", "dsh-sdk-jsonrpc-server", "lib", "index.js")).href;
  writeFileSync(
    installedBridgePatch,
    readFileSync(installedBridgePatch, "utf8").replace("__FLOWIX_DSH_SDK_SERVER__", JSON.stringify(sdkServerEntry)),
    { encoding: "utf8", mode: 0o600 },
  );

  const manifestPath = join(profileDir, "package.json");
  if (!existsSync(manifestPath)) {
    copyFileSync(join(sourceDir, "package.json"), manifestPath);
  }
  const sourcePatchPath = join(sourceDir, "cordis.patch.yml");
  const targetPatchPath = join(profileDir, "cordis.patch.yml");
  if (existsSync(sourcePatchPath) && !existsSync(targetPatchPath)) {
    copyFileSync(sourcePatchPath, targetPatchPath);
  }
  let manifest: Record<string, any>;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        any
      >;
    } catch {
      // Do not overwrite a user-authored malformed profile. The DSH loader
      // will report its normal diagnostic with the original file intact.
      return;
    }
  } else {
    manifest = {
      name: "dsh-profile-flowix",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [] } },
    };
  }
  const orderedBundles = mergeFlowixProfileBundles(
    manifest.dsh?.profile?.bundles,
  );
  manifest.dsh = {
    ...(manifest.dsh ?? {}),
    profile: { ...(manifest.dsh?.profile ?? {}), bundles: orderedBundles },
  };
  mkdirSync(profileDir, { recursive: true });
  atomicWriteJson(manifestPath, manifest);
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.flowix-${process.pid}-${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

function copyProfilePackage(sourceDir: string, packageDir: string): void {
  mkdirSync(packageDir, { recursive: true });
  for (const entry of readdirSync(sourceDir)) {
    const source = join(sourceDir, entry);
    if (!existsSync(source)) continue;
    cpSync(source, join(packageDir, entry), { recursive: true, force: true });
  }
}

/** Find the profile payload in a downloaded DSH archive or a source checkout. */
function flowixProfileSourceDir(): string | undefined {
  const configured = process.env.FLOWIX_DSH_PROFILE_SOURCE?.trim();
  const candidates = [
    configured === undefined || configured === "" ? undefined : resolve(configured),
    join(hostRoot(), "profile", "flowix"),
    // Packaged sidecar E2E keeps the host in app/flowix-desktop/binaries while
    // the source checkout owns the profile at the repository root.
    join(hostRoot(), "..", "..", "dsh-flowix-host", "profile", "flowix"),
  ].filter((value): value is string => value !== undefined);
  return candidates.find((candidate) => existsSync(join(candidate, "package.json")));
}

function flowixMemorySourceDir(): string | undefined {
  return [
    join(hostRoot(), "runtime", "node_modules", "dsh-flowix-memory"),
    join(hostRoot(), "dsh-flowix-memory"),
    join(hostRoot(), "..", "dsh-flowix-memory"),
    join(hostRoot(), "..", "..", "dsh-flowix-memory"),
  ].find((candidate) => existsSync(join(candidate, "package.json")));
}

/**
 * Build the env block shared by every runtime launch path. `FLOWIX_DSH_BUILD_ID`
 * travels into the runtime so a paired host/runtime always come from the same
 * build; the launcher refuses mismatches.
 */
function withBuildId(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [SIDECAR_BUILD_ID_ENV]: SIDECAR_BUILD_ID };
}

export function runtimeLaunch(spec: RuntimeSpec): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  // Integration tests may provide a small JSON-RPC runtime fixture. Keep this
  // override explicit and ahead of the packaged-runtime probes so tests do
  // not accidentally exercise a real model catalog instead of the fixture.
  const configured = process.env.FLOWIX_DSH_RUNTIME_PATH?.trim();
  if (configured !== undefined && configured !== "") {
    return {
      command: configured,
      args: [],
      env: runtimeEnvironment(spec),
    };
  }

  // Managed Node Runtime Bundle: the host itself runs under the private Node
  // executable and starts the deployed DSH JSON-RPC entry from the same
  // versioned bundle. No system Node or SEA dispatcher is involved.
  const bundledDshCliEntry = join(
    hostRoot(),
    "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js",
  );
  if (existsSync(bundledDshCliEntry)) {
    return {
      command: process.execPath,
      // Follow the official CLI/Web boot path: the CLI resolves the Flowix
      // profile, composes dsh-base + profile/home patches, and then mounts the
      // stdio JSON-RPC server contributed by the Flowix profile. Passing the
      // empty profile root directly to packaged-bin would boot no plugins and
      // make the child exit as soon as the client attempted initialization.
      args: [bundledDshCliEntry, "--profile", "flowix"],
      env: runtimeEnvironment(spec),
    };
  }

  // Release path: when dsh-host runs as a SEA, the runtime sidecar lives
  // next to it inside the bundle. Probe the directory that owns the current
  // executable (the SEA itself) for both the rustc-triple-suffixed and the
  // bare names, in that order.
  const packaged = packagedRuntimeBinary();
  if (packaged !== undefined) {
    return {
      command: packaged,
      args: [cordisConfigPath()],
      env: withBuildId({
        ...runtimeEnvironment(spec),
        DSH_EMBEDDED_RUNTIME_MODE: "1",
      }),
    };
  }

  // Dev path: prefer the packaged runtime that build-host.mjs produced. The
  // vendored tsx + bin.ts path is fragile (Cordis plugin tree loads through
  // workspace links and tsx has ordering surprises that leave the harness
  // client in an inconsistent state when init fails), so dev and prod both
  // use the SEA binary. If it is missing the build pipeline was skipped;
  // fall back to tsx so a cold checkout can still boot the launcher.
  const devPackaged = devPackagedRuntimeBinary();
  if (devPackaged !== undefined) {
    return {
      command: devPackaged,
      args: [cordisConfigPath()],
      env: withBuildId({
        ...runtimeEnvironment(spec),
        DSH_EMBEDDED_RUNTIME_MODE: "1",
      }),
    };
  }

  const root = hostRoot();
  const bin = join(
    root,
    "vendor/deepseek-harness/packages/examples/jsonrpc-demo/src/bin.ts",
  );
  const tsxLoader = join(
    root,
    "vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs",
  );
  if (!existsSync(bin) || !existsSync(tsxLoader)) {
    throw new Error(
      "dsh-runtime is not bundled and the vendored development runtime is not installed; run npm --prefix dsh-flowix-host run build:dev (which auto-builds the packaged runtime)",
    );
  }
  return {
    command: process.execPath,
    args: ["--import", pathToFileURL(tsxLoader).href, bin, cordisConfigPath()],
    // The agent runs with the user's workspace as cwd, but the vendored
    // Harness source tree owns the TS path aliases for all @deepseek-ai/*
    // workspace packages. Without this explicit config, tsx resolves from
    // the user's cwd and the child exits before the first model request.
    env: withBuildId({
      ...runtimeEnvironment(spec),
      TSX_TSCONFIG_PATH: join(root, "vendor/deepseek-harness/tsconfig.json"),
    }),
  };
}

function cordisConfigPath(disabled = disabledPluginKeys()): string {
  const configured = process.env.FLOWIX_DSH_CORDIS_CONFIG;
  if (configured !== undefined && configured !== "") return configured;
  const developmentConfig = join(hostRoot(), "config/flowix.cordis.yml");
  if (existsSync(developmentConfig) && !hasScopeDisables(disabled, "host"))
    return developmentConfig;

  // A downloaded DSH host has no source tree beside it. Materialize the
  // config bundled into dsh-host so the independently installed package
  // remains self-contained.
  const runtimeConfigRoot = join(sessionBaseRoot(), ".runtime");
  const runtimeConfig = join(runtimeConfigRoot, "flowix.cordis.yml");
  mkdirSync(runtimeConfigRoot, { recursive: true });
  writeFileSync(
    runtimeConfig,
    applyPluginDisables(DEFAULT_CORDIS_CONFIG, "host", undefined, disabled),
    { encoding: "utf8", mode: 0o600 },
  );
  return runtimeConfig;
}

function presetRootPath(disabled = disabledPluginKeys()): string {
  const configured = process.env.FLOWIX_DSH_PRESET_ROOT;
  if (configured !== undefined && configured !== "") return configured;
  const developmentRoot = join(
    hostRoot(),
    "vendor/deepseek-harness/apps/cli/config/agent-presets",
  );
  if (existsSync(developmentRoot) && !hasScopeDisables(disabled, "preset"))
    return developmentRoot;

  const root = join(sessionBaseRoot(), ".runtime", "agent-presets");
  const presets = [
    ["standard", STANDARD_PRESET, STANDARD_PRESET_META],
    ["code", CODE_PRESET, CODE_PRESET_META],
    ["minimal", MINIMAL_PRESET, MINIMAL_PRESET_META],
    ["cordis", CORDIS_PRESET, CORDIS_PRESET_META],
  ] as const;
  for (const [id, composition, metadata] of presets) {
    const directory = join(root, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "agent.cordis.yml"),
      applyPluginDisables(composition, "preset", id, disabled),
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(join(directory, "preset.yml"), metadata, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return root;
}

function sessionBaseRoot(): string {
  return process.env.FLOWIX_DSH_SESSION_ROOT ?? join(hostRoot(), ".sessions");
}

function hostRoot(): string {
  const configured = process.env.FLOWIX_DSH_ROOT;
  if (configured !== undefined && configured !== "") return configured;
  // argv[1] is the built script under Node and the executable itself under
  // SEA. Avoid import.meta here because the SEA entry must be CommonJS.
  const entryDirectory = dirname(resolve(process.argv[1] ?? process.execPath));
  if (existsSync(join(entryDirectory, "config/flowix.cordis.yml")))
    return entryDirectory;
  const parent = dirname(entryDirectory);
  if (existsSync(join(parent, "config/flowix.cordis.yml"))) return parent;
  return entryDirectory;
}

/**
 * Resolve the flowix-cli executable used by the `dsh-flowix-memory` composition row.
 * Flowix passes the main app's CLI through FLOWIX_DSH_MCP_CLI because the
 * downloaded DSH host lives outside Flowix.app. An explicit override still
 * wins for tests and custom launchers. Absent a candidate, the runtime falls
 * back to `flowix` on PATH.
 */
function flowixCliPath(): string | undefined {
  const configured = process.env.FLOWIX_DSH_MCP_CLI;
  if (configured !== undefined && configured !== "") return configured;
  const candidates = [
    join(dirname(resolve(process.execPath)), "flowix-cli"),
    join(hostRoot(), "../flowix-desktop/binaries/flowix-cli"),
  ];
  return candidates.find(existsSync);
}

function hasScopeDisables(
  disabled: ReadonlySet<string>,
  scope: "host" | "preset",
): boolean {
  const prefix = `${scope}:`;
  for (const key of disabled) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
/**
 * Locate the packaged runtime that build-host.mjs produced for the host
 * platform. Returns undefined if not built, in which case the caller falls
 * back to the vendored tsx + bin.ts path.
 */
function devPackagedRuntimeBinary(): string | undefined {
  const binary = join(
    hostRoot(),
    "../.build/flowix-dsh-host/dsh-runtime" +
      (process.platform === "win32" ? ".exe" : ""),
  );
  return existsSync(binary) ? binary : undefined;
}

/**
 * Locate the runtime sidecar that ships next to this dsh-host process.
 * Mirrors `host.rs:packaged_runtime_candidate` so the launcher and the
 * host agree on which binary counts as the runtime.
 *
 * Returns undefined for the dev bundle (process.execPath is node) and when
 * the sidecar is missing from the install directory.
 */
function packagedRuntimeBinary(): string | undefined {
  const exe = process.execPath;
  const exeExt = extname(exe).toLowerCase();
  // The vendored dev bundle runs under node and lives in
  // .build/flowix-dsh-host/; only SEA launches report a real .exe path here.
  if (exeExt === ".exe" || exeExt === "" || exeExt === ".bin") {
    // Dev bundle: the vendored launcher runs as `node dsh-host.cjs`,
    // so process.execPath points to the node binary. The dispatcher only
    // exists inside the SEA, so falling through to devPackagedRuntimeBinary
    // is required; otherwise the host would spawn plain node.exe as the
    // runtime and the turn would fail with no script.
    if (basename(exe, exeExt).toLowerCase() === "node") {
      return undefined;
    }
    // FLOWIX: dual-mode SEA. The host and the runtime are the same binary.
    // The dispatcher in scripts/build-exe-for-python-sdk.ts reads
    // DSH_EMBEDDED_RUNTIME_MODE and routes the process into the vendored
    // packaged-bin entry when the host launches us in runtime mode. A
    // separate dsh-runtime sidecar would only duplicate the whole closure
    // inside the NSIS installer, so the install ships dsh-host only.
    return exe;
  }
  return undefined;
}
