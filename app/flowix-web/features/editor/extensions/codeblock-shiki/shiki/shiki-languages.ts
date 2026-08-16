// ── 精选语言 / 主题注册表 ────────────────────────────────────────────
//
// 取代 shiki 的全量 bundledLanguages / bundledThemes。全量会把 119 种语言
// grammar + 44 套主题全部打进前端包 (桌面端整体内嵌进二进制), 而实际常用
// 的只有几十种。这里改为「显式 import 谁, 谁才进包」的细粒度方案:
//   - 主题: 2 套 (github-light 亮 / github-dark 暗), 与 codeblock-shiki.ts 的 PRELOADED_SHIKI_THEMES 一一对应。
//   - 语言: 按使用频率精选 ~30 种; 未列入的冷门语言走 plaintext 降级。
//
// 每个 import 会把对应 grammar / theme 静态打进包, 未 import 的不会进入
// bundle。别名 (e.g. js→javascript, sh/bash→shellscript) 由 Shiki 在
// loadLanguage 时依据 registration 的 `aliases` 字段自动登记, getLoadedLanguages()
// 会同时返回 canonical 名 + 别名, 因此 ```js / ```sh 这类 fence 照常高亮。

// 主题 ── 2 套 (亮/暗)。
import githubLight from '@shikijs/themes/github-light'
import githubDark from '@shikijs/themes/github-dark'

// 语言 ── 精选 ~30 种。新增语言只需加一行 import + 加进 SHIKI_LANGS。
import javascript from '@shikijs/langs/javascript'
import typescript from '@shikijs/langs/typescript'
import tsx from '@shikijs/langs/tsx'
import jsx from '@shikijs/langs/jsx'
import python from '@shikijs/langs/python'
import rust from '@shikijs/langs/rust'
import go from '@shikijs/langs/go'
import java from '@shikijs/langs/java'
import kotlin from '@shikijs/langs/kotlin'
import swift from '@shikijs/langs/swift'
import c from '@shikijs/langs/c'
import cpp from '@shikijs/langs/cpp'
import csharp from '@shikijs/langs/csharp'
import php from '@shikijs/langs/php'
import ruby from '@shikijs/langs/ruby'
import lua from '@shikijs/langs/lua'
import shellscript from '@shikijs/langs/shellscript'
import sql from '@shikijs/langs/sql'
import json from '@shikijs/langs/json'
import yaml from '@shikijs/langs/yaml'
import toml from '@shikijs/langs/toml'
import xml from '@shikijs/langs/xml'
import html from '@shikijs/langs/html'
import css from '@shikijs/langs/css'
import scss from '@shikijs/langs/scss'
import markdown from '@shikijs/langs/markdown'
import docker from '@shikijs/langs/docker'
import diff from '@shikijs/langs/diff'
import graphql from '@shikijs/langs/graphql'
import ini from '@shikijs/langs/ini'
import make from '@shikijs/langs/make'
import powershell from '@shikijs/langs/powershell'

/** 精选主题 ── 传给 createHighlighterCore, 全部预加载。 */
export const SHIKI_THEMES = [
  githubLight,
  githubDark,
]

/** 精选语言 ── 每个元素是 LanguageRegistration[] (默认导出即数组)。 */
export const SHIKI_LANGS = [
  javascript,
  typescript,
  tsx,
  jsx,
  python,
  rust,
  go,
  java,
  kotlin,
  swift,
  c,
  cpp,
  csharp,
  php,
  ruby,
  lua,
  shellscript,
  sql,
  json,
  yaml,
  toml,
  xml,
  html,
  css,
  scss,
  markdown,
  docker,
  diff,
  graphql,
  ini,
  make,
  powershell,
]

export interface ShikiLanguageOption {
  id: string
  label: string
}

/** 语言选择器选项 ── 派生自 registration 的 name / displayName。
 *  只列 canonical id (不列别名), 避免 dropdown 里重复条目。 */
export const SHIKI_LANGUAGE_OPTIONS: readonly ShikiLanguageOption[] =
  SHIKI_LANGS.flat().map((lang) => ({
    id: lang.name,
    label: lang.displayName ?? lang.name,
  }))

/** id / 别名 → 显示名 的映射 ── 用于把 button 上的 fence 名 (含别名
 *  e.g. "js" / "sh") 解析成人类可读 label (e.g. "JavaScript" / "Shell Script")。 */
export const SHIKI_LANGUAGE_LABEL_BY_ID: ReadonlyMap<string, string> =
  (() => {
    const map = new Map<string, string>()
    for (const lang of SHIKI_LANGS.flat()) {
      const label = lang.displayName ?? lang.name
      map.set(lang.name, label)
      for (const alias of lang.aliases ?? []) {
        if (!map.has(alias)) map.set(alias, label)
      }
    }
    return map
  })()
