import { chmod, mkdir } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const repo = resolve(root, '../..')
const outdir = resolve(repo, '.build/flowix-dsh-host')
await mkdir(outdir, { recursive: true })

// The vendored tree uses pnpm's isolated linker: workspace packages carry no
// own node_modules for registry deps, and the single materialized copy of
// `@earendil-works/pi-ai` lives in the root virtual store. Point esbuild at
// that store directory so `llm-pi-ai`'s catalog and discovery modules resolve.
const pnpmStore = resolve(root, 'vendor/deepseek-harness/node_modules/.pnpm')
const pnpmVirtualNodeModules = resolve(pnpmStore, 'node_modules')
const piAiEntry = readdirSync(pnpmStore)
  .find(name => name.startsWith('@earendil-works+pi-ai@'))
if (piAiEntry === undefined) {
  throw new Error(`no @earendil-works/pi-ai copy under ${pnpmStore}; run "npm run vendor:install" first`)
}
const piAiNodeModules = resolve(pnpmStore, piAiEntry, 'node_modules')

// `dsh-llm`'s attribution module reads its own package.json through
// `createRequire(import.meta.url)`; inside a bundle there is no neighboring
// manifest, so inline the version the same file would have read.
const llmPkg = JSON.parse(readFileSync(
  resolve(root, 'vendor/deepseek-harness/packages/llm/llm/package.json'), 'utf8'))
const inlineLlmVersion = {
  name: 'inline-dsh-llm-version',
  setup(builder) {
    builder.onLoad({ filter: /llm[\\/]src[\\/]attribution\.ts$/ }, args => ({
      contents: readFileSync(args.path, 'utf8').replace(
        /const \{ version \} = createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\) as \{ version: string \}/,
        `const version = ${JSON.stringify(llmPkg.version)}`,
      ),
      loader: 'ts',
    }))
  },
}

await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile: resolve(outdir, 'dsh-host.cjs'),
  bundle: true,
  platform: 'node',
  // @yao-pkg/pkg's SEA bootstrap evaluates its entry as CommonJS.
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  loader: { '.yml': 'text' },
  tsconfig: resolve(root, 'tsconfig.build.json'),
  nodePaths: [pnpmVirtualNodeModules, piAiNodeModules],
  plugins: [inlineLlmVersion],
})
await chmod(resolve(outdir, 'dsh-host.cjs'), 0o755)
process.stdout.write(`built ${resolve(outdir, 'dsh-host.cjs')}\n`)
