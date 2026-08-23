import githubDark from '@shikijs/themes/github-dark'
import githubLight from '@shikijs/themes/github-light'

import type { LanguageRegistration } from '@shikijs/types'

/** Keep display metadata synchronous while loading each grammar on demand. */
interface ShikiLanguageDefinition {
  id: string
  label: string
  aliases?: readonly string[]
  load: () => Promise<LanguageRegistration[]>
}

const SHIKI_LANGUAGE_DEFINITIONS: readonly ShikiLanguageDefinition[] = [
  { id: 'javascript', label: 'JavaScript', aliases: ['js'], load: async () => (await import('@shikijs/langs/javascript')).default },
  { id: 'typescript', label: 'TypeScript', aliases: ['ts'], load: async () => (await import('@shikijs/langs/typescript')).default },
  { id: 'tsx', label: 'TSX', load: async () => (await import('@shikijs/langs/tsx')).default },
  { id: 'jsx', label: 'JSX', load: async () => (await import('@shikijs/langs/jsx')).default },
  { id: 'python', label: 'Python', aliases: ['py'], load: async () => (await import('@shikijs/langs/python')).default },
  { id: 'rust', label: 'Rust', aliases: ['rs'], load: async () => (await import('@shikijs/langs/rust')).default },
  { id: 'go', label: 'Go', load: async () => (await import('@shikijs/langs/go')).default },
  { id: 'java', label: 'Java', load: async () => (await import('@shikijs/langs/java')).default },
  { id: 'kotlin', label: 'Kotlin', aliases: ['kt', 'kts'], load: async () => (await import('@shikijs/langs/kotlin')).default },
  { id: 'swift', label: 'Swift', load: async () => (await import('@shikijs/langs/swift')).default },
  { id: 'c', label: 'C', load: async () => (await import('@shikijs/langs/c')).default },
  { id: 'cpp', label: 'C++', aliases: ['c++'], load: async () => (await import('@shikijs/langs/cpp')).default },
  { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'], load: async () => (await import('@shikijs/langs/csharp')).default },
  { id: 'php', label: 'PHP', load: async () => (await import('@shikijs/langs/php')).default },
  { id: 'ruby', label: 'Ruby', aliases: ['rb'], load: async () => (await import('@shikijs/langs/ruby')).default },
  { id: 'lua', label: 'Lua', load: async () => (await import('@shikijs/langs/lua')).default },
  { id: 'shellscript', label: 'Shell Script', aliases: ['shell', 'bash', 'sh', 'zsh'], load: async () => (await import('@shikijs/langs/shellscript')).default },
  { id: 'sql', label: 'SQL', load: async () => (await import('@shikijs/langs/sql')).default },
  { id: 'json', label: 'JSON', aliases: ['jsonc', 'json5'], load: async () => (await import('@shikijs/langs/json')).default },
  { id: 'yaml', label: 'YAML', aliases: ['yml'], load: async () => (await import('@shikijs/langs/yaml')).default },
  { id: 'toml', label: 'TOML', load: async () => (await import('@shikijs/langs/toml')).default },
  { id: 'xml', label: 'XML', load: async () => (await import('@shikijs/langs/xml')).default },
  { id: 'html', label: 'HTML', load: async () => (await import('@shikijs/langs/html')).default },
  { id: 'css', label: 'CSS', load: async () => (await import('@shikijs/langs/css')).default },
  { id: 'scss', label: 'SCSS', load: async () => (await import('@shikijs/langs/scss')).default },
  { id: 'markdown', label: 'Markdown', aliases: ['md'], load: async () => (await import('@shikijs/langs/markdown')).default },
  { id: 'docker', label: 'Dockerfile', aliases: ['dockerfile'], load: async () => (await import('@shikijs/langs/docker')).default },
  { id: 'diff', label: 'Diff', load: async () => (await import('@shikijs/langs/diff')).default },
  { id: 'graphql', label: 'GraphQL', aliases: ['gql'], load: async () => (await import('@shikijs/langs/graphql')).default },
  { id: 'ini', label: 'INI', aliases: ['properties'], load: async () => (await import('@shikijs/langs/ini')).default },
  { id: 'make', label: 'Makefile', aliases: ['makefile'], load: async () => (await import('@shikijs/langs/make')).default },
  { id: 'powershell', label: 'PowerShell', aliases: ['ps', 'ps1'], load: async () => (await import('@shikijs/langs/powershell')).default },
]

export const SHIKI_THEMES = [githubLight, githubDark]

export interface ShikiLanguageOption {
  id: string
  label: string
}

export const SHIKI_LANGUAGE_OPTIONS: readonly ShikiLanguageOption[] =
  SHIKI_LANGUAGE_DEFINITIONS.map(({ id, label }) => ({ id, label }))

const SHIKI_LANGUAGE_BY_ID = new Map<string, ShikiLanguageDefinition>()
for (const definition of SHIKI_LANGUAGE_DEFINITIONS) {
  SHIKI_LANGUAGE_BY_ID.set(definition.id, definition)
  for (const alias of definition.aliases ?? []) {
    SHIKI_LANGUAGE_BY_ID.set(alias, definition)
  }
}

export const SHIKI_LANGUAGE_LABEL_BY_ID: ReadonlyMap<string, string> =
  new Map([...SHIKI_LANGUAGE_BY_ID].map(([id, definition]) => [id, definition.label]))

export function getShikiLanguageDefinition(
  language: string | null | undefined,
): ShikiLanguageDefinition | null {
  if (!language) return null
  return SHIKI_LANGUAGE_BY_ID.get(language.toLowerCase()) ?? null
}
