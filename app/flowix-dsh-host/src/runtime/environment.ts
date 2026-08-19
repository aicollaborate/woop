import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeSpec } from '../protocol/v1.ts'
import { disabledPluginKeys } from './plugin-directory.ts'
import { applyPluginDisables } from './plugin-composition.ts'
import { SIDECAR_BUILD_ID, SIDECAR_BUILD_ID_ENV } from '../build-meta.ts'
import DEFAULT_CORDIS_CONFIG from '../../config/flowix.cordis.yml'
import STANDARD_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml'
import STANDARD_PRESET_META from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/standard/preset.yml'
import CODE_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/code/agent.cordis.yml'
import CODE_PRESET_META from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/code/preset.yml'
import MINIMAL_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/minimal/agent.cordis.yml'
import MINIMAL_PRESET_META from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/minimal/preset.yml'
import CORDIS_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/cordis/agent.cordis.yml'
import CORDIS_PRESET_META from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/cordis/preset.yml'

const PASSTHROUGH = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'HOME', 'USERPROFILE',
  'NODE_USE_ENV_PROXY',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
] as const

export function runtimeEnvironment(spec: RuntimeSpec): NodeJS.ProcessEnv {
  const disabled = disabledPluginKeys()
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const key of ['DSH_API_KEY', 'DSH_SETTINGS_PATH'] as const) {
    const value = process.env[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  env.DSH_CWD = spec.cwd
  // Flowix owns the harness home. Point the harness's own resolver (skills,
  // AGENTS.md, storage domains) at the single dsh root instead of ~/.dsh.
  const dshHome = process.env.FLOWIX_DSH_HOME
  if (dshHome !== undefined && dshHome !== '') env.DSH_HOME = dshHome
  // The vendored sandbox consumes this as a write-root list. Keep the JSON
  // boundary explicit so paths never become shell syntax or prompt text.
  env.DSH_WORKSPACE_ROOTS = JSON.stringify([...new Set([spec.cwd, ...spec.workspacePaths])])
  env.DSH_PROVIDER = spec.provider
  env.DSH_PROVIDER_NAME = spec.providerName
  env.DSH_API_PROTOCOL = spec.apiProtocol
  env.DSH_BASE_URL = spec.baseUrl
  env.DSH_MODEL = spec.model
  if (env.DSH_API_KEY !== undefined) env.DSH_API_KEY_ENV = 'DSH_API_KEY'
  env.DSH_PERMISSION_MODE = spec.permissionMode
  env.DSH_AGENT_PRESET = spec.agentPreset
  env.DSH_AGENT_PRESET_ROOT = presetRootPath(disabled)
  // Match the official Harness layout: the persistence plugin itself owns
  // the project/session-id directories beneath <DSH_HOME>/sessions.
  env.DSH_SESSION_ROOT = sessionBaseRoot()
  env.DSH_CORDIS_CONFIG = cordisConfigPath(disabled)
  const mcpCli = flowixCliPath()
  if (mcpCli !== undefined) env.FLOWIX_DSH_MCP_CLI = mcpCli
  env.DSH_SETTINGS_MODULE = pathToFileURL(join(
    hostRoot(),
    'vendor/deepseek-harness/packages/settings/settings-file/src/index.ts',
  )).href
  return env
}

/**
 * Build the env block shared by every runtime launch path. `FLOWIX_DSH_BUILD_ID`
 * travels into the runtime so a paired host/runtime always come from the same
 * build; the launcher refuses mismatches.
 */
function withBuildId(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, [SIDECAR_BUILD_ID_ENV]: SIDECAR_BUILD_ID }
}

export function runtimeLaunch(spec: RuntimeSpec): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  // Release path: when dsh-host runs as a SEA, the runtime sidecar lives
  // next to it inside the bundle. Probe the directory that owns the current
  // executable (the SEA itself) for both the rustc-triple-suffixed and the
  // bare names, in that order.
  const packaged = packagedRuntimeBinary()
  if (packaged !== undefined) {
    return {
      command: packaged,
      args: [cordisConfigPath()],
      env: withBuildId({ ...runtimeEnvironment(spec), FLOWIX_DSH_RUNTIME_MODE: '1' }),
    }
  }

  // Dev path: prefer the packaged runtime that build-host.mjs produced. The
  // vendored tsx + bin.ts path is fragile (Cordis plugin tree loads through
  // workspace links and tsx has ordering surprises that leave the harness
  // client in an inconsistent state when init fails), so dev and prod both
  // use the SEA binary. If it is missing the build pipeline was skipped;
  // fall back to tsx so a cold checkout can still boot the launcher.
  const devPackaged = devPackagedRuntimeBinary()
  if (devPackaged !== undefined) {
    return {
      command: devPackaged,
      args: [cordisConfigPath()],
      env: withBuildId({ ...runtimeEnvironment(spec), FLOWIX_DSH_RUNTIME_MODE: '1' }),
    }
  }

  const root = hostRoot()
  const bin = join(root, 'vendor/deepseek-harness/packages/examples/jsonrpc-demo/src/bin.ts')
  const tsxLoader = join(root, 'vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs')
  if (!existsSync(bin) || !existsSync(tsxLoader)) {
    throw new Error('dsh-runtime is not bundled and the vendored development runtime is not installed; run npm --prefix app/flowix-dsh-host run build:dev (which auto-builds the packaged runtime)')
  }
  return {
    command: process.execPath,
    args: ['--import', pathToFileURL(tsxLoader).href, bin, cordisConfigPath()],
    // The agent runs with the user's workspace as cwd, but the vendored
    // Harness source tree owns the TS path aliases for all @deepseek-ai/*
    // workspace packages. Without this explicit config, tsx resolves from
    // the user's cwd and the child exits before the first model request.
    env: withBuildId({
      ...runtimeEnvironment(spec),
      TSX_TSCONFIG_PATH: join(root, 'vendor/deepseek-harness/tsconfig.json'),
    }),
  }
}

function cordisConfigPath(disabled = disabledPluginKeys()): string {
  const configured = process.env.FLOWIX_DSH_CORDIS_CONFIG
  if (configured !== undefined && configured !== '') return configured
  const developmentConfig = join(hostRoot(), 'config/flowix.cordis.yml')
  if (existsSync(developmentConfig) && !hasScopeDisables(disabled, 'host')) return developmentConfig

  // A Tauri externalBin is installed in Contents/MacOS (or the platform
  // equivalent) without the source tree. Materialize the config bundled into
  // dsh-host so the production sidecar remains self-contained.
  const runtimeConfigRoot = join(sessionBaseRoot(), '.runtime')
  const runtimeConfig = join(runtimeConfigRoot, 'flowix.cordis.yml')
  mkdirSync(runtimeConfigRoot, { recursive: true })
  writeFileSync(runtimeConfig, applyPluginDisables(DEFAULT_CORDIS_CONFIG, 'host', undefined, disabled), { encoding: 'utf8', mode: 0o600 })
  return runtimeConfig
}

function presetRootPath(disabled = disabledPluginKeys()): string {
  const configured = process.env.FLOWIX_DSH_PRESET_ROOT
  if (configured !== undefined && configured !== '') return configured
  const developmentRoot = join(hostRoot(), 'vendor/deepseek-harness/apps/cli/config/agent-presets')
  if (existsSync(developmentRoot) && !hasScopeDisables(disabled, 'preset')) return developmentRoot

  const root = join(sessionBaseRoot(), '.runtime', 'agent-presets')
  const presets = [
    ['standard', STANDARD_PRESET, STANDARD_PRESET_META],
    ['code', CODE_PRESET, CODE_PRESET_META],
    ['minimal', MINIMAL_PRESET, MINIMAL_PRESET_META],
    ['cordis', CORDIS_PRESET, CORDIS_PRESET_META],
  ] as const
  for (const [id, composition, metadata] of presets) {
    const directory = join(root, id)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'agent.cordis.yml'), applyPluginDisables(composition, 'preset', id, disabled), { encoding: 'utf8', mode: 0o600 })
    writeFileSync(join(directory, 'preset.yml'), metadata, { encoding: 'utf8', mode: 0o600 })
  }
  return root
}

function sessionBaseRoot(): string {
  return process.env.FLOWIX_DSH_SESSION_ROOT ?? join(hostRoot(), '.sessions')
}

function hostRoot(): string {
  const configured = process.env.FLOWIX_DSH_ROOT
  if (configured !== undefined && configured !== '') return configured
  // argv[1] is the built script under Node and the executable itself under
  // SEA. Avoid import.meta here because the SEA entry must be CommonJS.
  const entryDirectory = dirname(resolve(process.argv[1] ?? process.execPath))
  if (existsSync(join(entryDirectory, 'config/flowix.cordis.yml'))) return entryDirectory
  const parent = dirname(entryDirectory)
  if (existsSync(join(parent, 'config/flowix.cordis.yml'))) return parent
  return entryDirectory
}

/**
 * Resolve the flowix-cli executable used by the `dsh-flowix-memory` composition row.
 * Packaged builds place the CLI sidecar beside the dsh-host executable; the
 * development fallback is the CLI staged by `scripts/build-cli.sh`. An
 * explicit FLOWIX_DSH_MCP_CLI wins so tests and custom launchers can point at
 * any build. Absent a candidate, the runtime falls back to `flowix` on PATH.
 */
function flowixCliPath(): string | undefined {
  const configured = process.env.FLOWIX_DSH_MCP_CLI
  if (configured !== undefined && configured !== '') return configured
  const candidates = [
    join(dirname(resolve(process.execPath)), 'flowix-cli'),
    join(hostRoot(), '../flowix-desktop/binaries/flowix-cli'),
  ]
  return candidates.find(existsSync)
}

function hasScopeDisables(disabled: ReadonlySet<string>, scope: 'host' | 'preset'): boolean {
  const prefix = `${scope}:`
  for (const key of disabled) {
    if (key.startsWith(prefix)) return true
  }
  return false
}
/**
 * Locate the packaged runtime that build-host.mjs produced for the host
 * platform. Returns undefined if not built, in which case the caller falls
 * back to the vendored tsx + bin.ts path.
 */
function devPackagedRuntimeBinary(): string | undefined {
  const binary = join(hostRoot(), '../../.build/flowix-dsh-host/dsh-runtime' + (process.platform === 'win32' ? '.exe' : ''))
  return existsSync(binary) ? binary : undefined
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
  const exe = process.execPath
  const exeExt = extname(exe).toLowerCase()
  // The vendored dev bundle runs under node and lives in
  // .build/flowix-dsh-host/; only SEA launches report a real .exe path here.
  if (exeExt === '.exe' || exeExt === '' || exeExt === '.bin') {
    // Dev bundle: the vendored launcher runs as `node dsh-host.cjs`,
    // so process.execPath points to the node binary. The dispatcher only
    // exists inside the SEA, so falling through to devPackagedRuntimeBinary
    // is required; otherwise the host would spawn plain node.exe as the
    // runtime and the turn would fail with no script.
    if (basename(exe, exeExt).toLowerCase() === 'node') {
      return undefined
    }
    // FLOWIX: dual-mode SEA. The host and the runtime are the same binary.
    // The dispatcher in scripts/build-exe-for-python-sdk.ts reads
    // FLOWIX_DSH_RUNTIME_MODE and routes the process into the vendored
    // packaged-bin entry when the host launches us in runtime mode. A
    // separate dsh-runtime sidecar would only duplicate the whole closure
    // inside the NSIS installer, so the install ships dsh-host only.
    return exe
  }
  return undefined
}
