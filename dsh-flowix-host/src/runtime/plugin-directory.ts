import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import DEFAULT_CORDIS_CONFIG from '../../config/flowix.cordis.yml'
import STANDARD_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/standard/agent.cordis.yml'
import CODE_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/code/agent.cordis.yml'
import MINIMAL_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/minimal/agent.cordis.yml'
import CORDIS_PRESET from '../../vendor/deepseek-harness/apps/cli/config/agent-presets/cordis/agent.cordis.yml'
import { pluginKey, type HarnessPluginScope } from './plugin-composition.ts'

export interface HarnessPlugin {
  key: string
  id: string
  name: string
  enabled: boolean
  toggleable: boolean
  scope: HarnessPluginScope | 'profile'
  preset?: string
}

export interface HarnessPluginCatalog {
  platform: NodeJS.Platform
  host: HarnessPlugin[]
  presets: Record<string, HarnessPlugin[]>
  profile: HarnessPlugin[]
}

const PRESETS: Record<string, string> = {
  standard: STANDARD_PRESET,
  code: CODE_PRESET,
  minimal: MINIMAL_PRESET,
  cordis: CORDIS_PRESET,
}

export function disabledPluginKeys(): ReadonlySet<string> {
  const path = process.env.FLOWIX_DSH_PLUGIN_SETTINGS_PATH
  if (path === undefined || path === '') return new Set()
  try {
    if (!existsSync(path)) return new Set()
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { disabled?: unknown }
    if (!Array.isArray(parsed.disabled)) return new Set()
    return new Set(parsed.disabled.filter((value): value is string => typeof value === 'string'))
  } catch (error) {
    process.stderr.write(`[dsh-host] failed to read plugin settings: ${String(error)}\n`)
    return new Set()
  }
}

/**
 * Read the same Cordis compositions that the runtime bundles. This keeps the
 * preferences page derived from the deployment composition instead of having
 * a second, hand-maintained list in the web UI.
 *
 * The compositions intentionally use a small declarative subset here: every
 * plugin row has an id followed by a name, and optional disabled expressions.
 * Cordis groups are structural rows and are omitted from the plugin catalog.
 */
export function catalog(): HarnessPluginCatalog {
  const disabled = disabledPluginKeys()
  return {
    platform: process.platform,
    host: parseComposition(DEFAULT_CORDIS_CONFIG, 'host', undefined, disabled),
    presets: Object.fromEntries(
      Object.entries(PRESETS).map(([preset, source]) => [preset, parseComposition(source, 'preset', preset, disabled)]),
    ),
    profile: profilePlugins(),
  }
}

/** Inventory the official `flowix` profile rather than projecting a second
 * frontend-owned list. Packages installed through `dsh plugin` appear here
 * without Flowix having to know their schemas or registries. */
function profilePlugins(): HarnessPlugin[] {
  const home = process.env.DSH_HOME
  if (home === undefined || home === '') return []
  const profileDir = join(home, 'profiles', 'flowix')
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter((value): value is string => typeof value === 'string')
      : []
    return bundles.map((packageName) => {
      let displayName = packageName
      try {
        const packageManifest = JSON.parse(readFileSync(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8')) as {
          name?: string
          description?: string
        }
        displayName = packageManifest.description?.trim() || packageManifest.name?.trim() || packageName
      } catch {
        // Keep unresolved bundles visible. The official loader will provide
        // its normal actionable diagnostic when the profile is next booted.
      }
      return {
        key: `profile:${packageName}`,
        id: packageName,
        name: displayName,
        enabled: true,
        toggleable: false,
        scope: 'profile' as const,
      }
    })
  } catch {
    return []
  }
}

function parseComposition(
  source: string,
  scope: HarnessPluginScope,
  preset: string | undefined,
  disabled: ReadonlySet<string>,
): HarnessPlugin[] {
  const rows: HarnessPlugin[] = []
  let current: ParsedRow | undefined

  const flush = () => {
    if (current !== undefined && current.name !== undefined && current.name !== 'cordis:group') {
      const index = rows.length
      const key = pluginKey(scope, index, current.id, preset)
      const legacyKey = scope === 'host'
        ? `host:${index}:${current.id}`
        : `preset:${preset ?? 'standard'}:${index}:${current.id}`
      rows.push({
        key,
        id: current.id,
        name: current.name,
        enabled: !current.disabled && !disabled.has(key) && !disabled.has(legacyKey),
        // Host entries form one dependency graph for the process. Preset
        // entries are the user-facing capability boundary and can be safely
        // rebuilt on the next runtime; host entries stay protected.
        toggleable: !current.disabled && scope === 'preset',
        scope,
        ...(preset === undefined ? {} : { preset }),
      })
    }
    current = undefined
  }

  for (const line of source.split(/\r?\n/)) {
    const idMatch = /^(\s*)- id:\s*(.+?)\s*$/.exec(line)
    if (idMatch !== null) {
      flush()
      current = { id: cleanScalar(idMatch[2]!), indent: idMatch[1]!.length, index: -1 }
      continue
    }
    if (current === undefined) continue

    const nameMatch = /^(\s+)name:\s*(.+?)\s*$/.exec(line)
    if (nameMatch !== null && current.name === undefined && nameMatch[1]!.length > current.indent) {
      current.name = cleanName(nameMatch[2]!, current.id)
      continue
    }

    const disabledMatch = /^(\s+)disabled:\s*(.+?)\s*$/.exec(line)
    if (disabledMatch !== null && disabledMatch[1]!.length > current.indent) {
      current.disabled = evaluateDisabled(disabledMatch[2]!)
    }
  }
  flush()
  return rows
}

interface ParsedRow {
  id: string
  indent: number
  name?: string
  disabled?: boolean
  index: number
  hasDisabled?: boolean
}

function cleanName(value: string, fallback: string): string {
  const normalized = cleanScalar(value.trim().replace(/^!!js\s+/, ''))
  if (normalized.startsWith('process.env') || normalized.startsWith('process.')) return fallback
  return normalized
}

function cleanScalar(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function evaluateDisabled(value: string): boolean {
  const expression = value.trim().replace(/^!!js\s+/, '')
  if (expression === 'true') return true
  if (expression === 'false') return false
  if (expression === 'process.platform === \'win32\'' || expression === 'process.platform === "win32"') {
    return process.platform === 'win32'
  }
  if (expression === 'process.platform !== \'win32\'' || expression === 'process.platform !== "win32"') {
    return process.platform !== 'win32'
  }
  return false
}
