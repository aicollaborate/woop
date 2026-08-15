import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { RuntimeSpec } from '../protocol/v1.ts'
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
] as const

export function runtimeEnvironment(spec: RuntimeSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  for (const key of ['DSH_API_KEY'] as const) {
    const value = process.env[key]
    if (value !== undefined && value !== '') env[key] = value
  }
  env.DSH_CWD = spec.cwd
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
  env.DSH_AGENT_PRESET_ROOT = presetRootPath()
  env.DSH_SESSION_ROOT = sessionRoot(spec.sessionId)
  env.DSH_CORDIS_CONFIG = cordisConfigPath()
  return env
}

export function runtimeLaunch(spec: RuntimeSpec): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const configured = process.env.FLOWIX_DSH_RUNTIME_PATH
  if (configured !== undefined && configured !== '') {
    return {
      command: configured,
      args: [cordisConfigPath()],
      env: { ...runtimeEnvironment(spec), FLOWIX_DSH_RUNTIME_MODE: '1' },
    }
  }

  const root = hostRoot()
  const bin = join(root, 'vendor/deepseek-harness/packages/examples/jsonrpc-demo/src/bin.ts')
  const tsxLoader = join(root, 'vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs')
  if (!existsSync(bin) || !existsSync(tsxLoader)) {
    throw new Error('dsh-runtime is not bundled and the vendored development runtime is not installed')
  }
  return {
    command: process.execPath,
    args: ['--import', tsxLoader, bin, cordisConfigPath()],
    // The agent runs with the user's workspace as cwd, but the vendored
    // Harness source tree owns the TS path aliases for all @deepseek-ai/*
    // workspace packages. Without this explicit config, tsx resolves from
    // the user's cwd and the child exits before the first model request.
    env: {
      ...runtimeEnvironment(spec),
      TSX_TSCONFIG_PATH: join(root, 'vendor/deepseek-harness/tsconfig.json'),
    },
  }
}

function cordisConfigPath(): string {
  const configured = process.env.FLOWIX_DSH_CORDIS_CONFIG
  if (configured !== undefined && configured !== '') return configured
  const developmentConfig = join(hostRoot(), 'config/flowix.cordis.yml')
  if (existsSync(developmentConfig)) return developmentConfig

  // A Tauri externalBin is installed in Contents/MacOS (or the platform
  // equivalent) without the source tree. Materialize the config bundled into
  // dsh-host so the production sidecar remains self-contained.
  const runtimeConfigRoot = join(sessionBaseRoot(), '.runtime')
  const runtimeConfig = join(runtimeConfigRoot, 'flowix.cordis.yml')
  mkdirSync(runtimeConfigRoot, { recursive: true })
  writeFileSync(runtimeConfig, DEFAULT_CORDIS_CONFIG, { encoding: 'utf8', mode: 0o600 })
  return runtimeConfig
}

function presetRootPath(): string {
  const configured = process.env.FLOWIX_DSH_PRESET_ROOT
  if (configured !== undefined && configured !== '') return configured
  const developmentRoot = join(hostRoot(), 'vendor/deepseek-harness/apps/cli/config/agent-presets')
  if (existsSync(developmentRoot)) return developmentRoot

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
    writeFileSync(join(directory, 'agent.cordis.yml'), composition, { encoding: 'utf8', mode: 0o600 })
    writeFileSync(join(directory, 'preset.yml'), metadata, { encoding: 'utf8', mode: 0o600 })
  }
  return root
}

function sessionRoot(sessionId: string): string {
  const base = sessionBaseRoot()
  return `${base.replace(/[\\/]$/, '')}/${safeSegment(sessionId)}`
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

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_')
}
