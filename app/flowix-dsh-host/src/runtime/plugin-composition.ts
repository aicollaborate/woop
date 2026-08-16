export type HarnessPluginScope = 'host' | 'preset'

export function pluginKey(scope: HarnessPluginScope, index: number, id: string, preset?: string): string {
  return scope === 'host'
    ? `host:${index}:${id}`
    : `preset:${preset ?? 'standard'}:${index}:${id}`
}

/** Apply persisted disable overrides to a bundled Cordis composition. */
export function applyPluginDisables(
  source: string,
  scope: HarnessPluginScope,
  preset: string | undefined,
  disabled: ReadonlySet<string>,
): string {
  const output: string[] = []
  let current: ParsedRow | undefined
  let nextIndex = 0

  const flush = () => {
    if (current !== undefined && current.name !== undefined && current.name !== 'cordis:group') {
      const key = pluginKey(scope, current.index, current.id, preset)
      if (disabled.has(key) && !current.hasDisabled) {
        const disabledLine = `${' '.repeat(current.indent + 2)}disabled: true`
        let insertion = output.length
        while (insertion > 0 && output[insertion - 1]!.trim() === '') insertion -= 1
        output.splice(insertion, 0, disabledLine)
      }
    }
    current = undefined
  }

  for (const line of source.split(/\r?\n/)) {
    const idMatch = /^(\s*)- id:\s*(.+?)\s*$/.exec(line)
    if (idMatch !== null) {
      flush()
      current = {
        id: cleanScalar(idMatch[2]!),
        indent: idMatch[1]!.length,
        index: -1,
      }
      output.push(line)
      continue
    }
    if (current !== undefined) {
      const nameMatch = /^(\s+)name:\s*(.+?)\s*$/.exec(line)
      if (nameMatch !== null && current.name === undefined && nameMatch[1]!.length > current.indent) {
        current.name = cleanName(nameMatch[2]!, current.id)
        if (current.name !== 'cordis:group') current.index = nextIndex++
      }
      const disabledMatch = /^(\s+)disabled:\s*(.+?)\s*$/.exec(line)
      if (disabledMatch !== null && disabledMatch[1]!.length > current.indent) current.hasDisabled = true
    }
    output.push(line)
  }
  flush()
  return output.join('\n')
}

interface ParsedRow {
  id: string
  indent: number
  name?: string
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
