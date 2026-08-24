import { spawn } from 'node:child_process'
import { existsSync, writeFileSync as writeFile } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import { build } from 'esbuild'

await import('./ensure-upstream.mjs')

const root = resolve(import.meta.dirname, '..')
const repo = resolve(root, '..')
const outdir = resolve(repo, '.build/flowix-dsh-host')
const vendor = resolve(root, 'vendor/deepseek-harness')
const tooling = resolve(root, 'scripts/tooling')
const buildEnv = {
  ...process.env,
  CI: 'true',
  PATH: `${tooling}${delimiter}${process.env.PATH ?? ''}`,
}
await mkdir(outdir, { recursive: true })

// Generate (or reuse) a build identity for the dual-mode DSH SEA and write
// it next to the bundle so the launcher can pass it as an env var. The
// same identifier is baked into the bundle via esbuild --define so a
// binary that drifted from its env can be detected at startup.
const buildIdPath = resolve(outdir, 'dsh-build-id.txt')
const envBuildId = process.env.FLOWIX_DSH_BUILD_ID?.trim()
if (existsSync(buildIdPath)) {
  const persisted = readFileSync(buildIdPath, 'utf8').trim()
  if (envBuildId !== undefined && envBuildId !== '' && envBuildId !== persisted) {
    throw new Error(
      `FLOWIX_DSH_BUILD_ID=${envBuildId} conflicts with persisted ${persisted} in ${buildIdPath}`,
    )
  }
}
const buildId = envBuildId && envBuildId !== ''
  ? envBuildId
  : (existsSync(buildIdPath)
      ? readFileSync(buildIdPath, 'utf8').trim()
      : (await generateBuildId()))
if (!buildId) throw new Error('empty build id computed for dsh-host bundle')
await writeFile(buildIdPath, buildId + '\n', 'utf8')
process.stdout.write('dsh sidecar build id: ' + buildId + '\n')

async function generateBuildId() {
  const { randomBytes } = await import('node:crypto')
  // 6 bytes (~48 bits) of entropy is plenty for distinguishing sidecar pairs.
  // Render as base32 so the value is filesystem and shell safe everywhere.
  return randomBytes(6).toString('base64url')
}


// The launcher bundle needs the @earendil-works/pi-ai portion of the Harness
// pnpm store. Workspace packages are resolved through nodePaths below rather
// than through a complete flat node_modules tree, so use the store's shared
// package link as the readiness marker. This keeps incremental builds fast
// without assuming that every workspace package is hoisted to the top level.
const vendorStore = resolve(vendor, 'node_modules/.pnpm')
const vendorReady = existsSync(resolve(vendorStore, 'node_modules/@earendil-works/pi-ai'))
if (!vendorReady) {
  process.stdout.write('vendored harness workspace is missing; running corepack pnpm install...' + '\n')
  await new Promise((done, fail) => {
    const corepackCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
    const child = spawn(corepackCmd, ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--prod=false'], {
      cwd: vendor,
      stdio: 'inherit',
      env: buildEnv,
      // Windows refuses to spawn .cmd without shell=true since Node 20 (CVE-2024-27980).
      shell: process.platform === 'win32',
    })
    child.once('error', fail)
    child.once('exit', code => code === 0 ? done() : fail(new Error('pnpm install exited ' + code)))
  })
}

const pnpmStore = vendorStore
const pnpmVirtualNodeModules = resolve(pnpmStore, 'node_modules')
const piAiEntry = readdirSync(pnpmStore)
  .find(name => name.startsWith('@earendil-works+pi-ai@'))
if (piAiEntry === undefined) {
  throw new Error('no @earendil-works/pi-ai copy under ' + pnpmStore + '; run npm run vendor:install first')
}
const piAiNodeModules = resolve(pnpmStore, piAiEntry, 'node_modules')

const llmPkg = JSON.parse(readFileSync(
  resolve(root, 'vendor/deepseek-harness/packages/llm/llm/package.json'), 'utf8'))
const inlineLlmVersion = {
  name: 'inline-dsh-llm-version',
  setup(builder) {
    builder.onLoad({ filter: /llm[\\\\/]src[\\\\/]attribution\.ts$/ }, args => ({
      contents: readFileSync(args.path, 'utf8').replace(
        /const \{ version \} = createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\) as \{ version: string \}/,
        'const version = ' + JSON.stringify(llmPkg.version),
      ),
      loader: 'ts',
    }))
  },
}

/**
 * Output a CommonJS bundle as `dsh-host.cjs` so `resolve_host_command` in the
 * desktop crate can launch the dev host directly via `node dsh-host.cjs`.
 * `splitting` is only valid for `esm`, so a single-file CJS bundle is the
 * right shape here and matches the launcher contract pkg's `--launcher` flag
 * expects in the production build pipeline.
 */
await build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outdir,
  entryNames: 'dsh-host',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  sourcemap: true,
  outExtension: { '.js': '.cjs' },
  loader: { '.yml': 'text', '.bridge.txt': 'text' },
  tsconfig: resolve(root, 'tsconfig.build.json'),
  define: { '__FLOWIX_DSH_BUILD_ID__': JSON.stringify(buildId) },
  nodePaths: [pnpmVirtualNodeModules, piAiNodeModules],
  plugins: [inlineLlmVersion],
})
process.stdout.write('built ' + resolve(outdir, 'dsh-host.cjs') + '\n')

// Build the packaged runtime so dev mode can spawn a self-contained SEA binary
// instead of relying on the vendored tsx + bin.ts path. The vendored tsx path
// is fragile: Cordis plugin loading goes through workspace links and tsx has
// ordering surprises that leave the harness client in an inconsistent state
// when anything fails during init. The packaged runtime is what production
// ships, so using it in dev means dev and prod share the same failure
// surface and there is no second code path to debug.
//
// Skip the build when the artifact is already present so incremental
// `tauri dev` rebuilds stay fast. Rebuild manually after editing vendored
// harness sources: `npm --prefix dsh-flowix-host run build:runtime`.
const runtimeBinary = resolve(outdir, process.platform === 'win32' ? 'dsh-runtime.exe' : 'dsh-runtime')
if (process.env.FLOWIX_DSH_SKIP_RUNTIME !== '1' && !existsSync(runtimeBinary)) {
  process.stdout.write('packaged runtime missing; building via corepack pnpm exec tsx ...' + '\n')
  await new Promise((done, fail) => {
    const corepackCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
    const child = spawn(corepackCmd, ['pnpm@11.7.0', 'exec', 'tsx', 'scripts/build-exe-for-python-sdk.ts', '--skip-build'], {
      cwd: vendor,
      stdio: 'inherit',
      env: buildEnv,
      shell: process.platform === 'win32',
    })
    child.once('error', fail)
    child.once('exit', code => code === 0 ? done() : fail(new Error('packaged runtime build exited ' + code)))
  })
  const platformForUpstream = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform
  const upstreamExt = process.platform === 'win32' ? '.exe' : ''
  const upstream = resolve(vendor, `dist-exe/dsh-jsonrpc-agent-pkg-${platformForUpstream}-${process.arch}${upstreamExt}`)
  if (!existsSync(upstream)) {
    throw new Error('packaged runtime missing at ' + upstream + ' after build; check upstream output naming')
  }
  await copyFile(upstream, runtimeBinary)
  process.stdout.write('built ' + runtimeBinary + '\n')
}
