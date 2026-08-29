import { spawn } from 'node:child_process'
import { accessSync, constants, cpSync, existsSync, writeFileSync as writeFile } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { build } from 'esbuild'

if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`DSH builds require Node 24; current runtime is ${process.version}`)
}

await import('./ensure-upstream.mjs')

const root = resolve(import.meta.dirname, '..')
const repo = resolve(root, '..')
const outdir = resolve(repo, '.build/flowix-dsh-host')
const vendor = resolve(root, 'vendor/deepseek-harness')
const buildEnv = {
  ...process.env,
  CI: 'true',
  NODE_ENV: 'development',
  npm_config_production: 'false',
  NPM_CONFIG_PRODUCTION: 'false',
  PNPM_CONFIG_PRODUCTION: 'false',
  FLOWIX_REPO_ROOT: repo,
}
await mkdir(outdir, { recursive: true })

// The development launcher loads the profile snapshot under dsh-flowix-host,
// while production packaging copies the source package directly. Keep those
// two inputs aligned before calculating the development build identity so a
// local App Server change is immediately exercised by Tauri dev.
const appServerSource = resolve(repo, 'dsh-appserver')
const appServerProfile = resolve(root, 'profile/flowix/node_modules/dsh-appserver')
if (!existsSync(resolve(appServerSource, 'package.json'))) {
  throw new Error(`DSH App Server source is missing: ${appServerSource}`)
}
cpSync(appServerSource, appServerProfile, { recursive: true, force: true })

// Derive a reproducible identity from every source and lock input that defines
// the Flowix host/profile bundle. This detects stale outputs across worktrees
// and does not depend on a previously generated .build file.
const buildIdPath = resolve(outdir, 'dsh-build-id.txt')
const envBuildId = process.env.FLOWIX_DSH_BUILD_ID?.trim()
const buildId = sourceBuildId()
if (envBuildId !== undefined && envBuildId !== '' && envBuildId !== buildId) {
  throw new Error(`FLOWIX_DSH_BUILD_ID=${envBuildId} does not match source build id ${buildId}`)
}
if (!buildId) throw new Error('empty build id computed for dsh-host bundle')
await writeFile(buildIdPath, buildId + '\n', 'utf8')
process.stdout.write('dsh host build id: ' + buildId + '\n')

function sourceBuildId() {
  const hash = createHash('sha256')
  const inputs = [
    resolve(root, 'src'),
    resolve(root, 'profile'),
    resolve(root, 'patches'),
    resolve(root, 'package.json'),
    resolve(root, 'upstream.lock.json'),
    resolve(repo, 'dsh-flowix-memory'),
    resolve(repo, 'dsh-appserver'),
    resolve(repo, 'package-lock.json'),
  ]
  const add = (path) => {
    if (!existsSync(path)) throw new Error(`DSH build identity input is missing: ${path}`)
    const entries = readdirSync(path, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const child = resolve(path, entry.name)
      if (entry.isDirectory() && !['node_modules', '.git', '.build'].includes(entry.name)) add(child)
      else if (entry.isFile()) {
        hash.update(relative(repo, child).replaceAll('\\', '/'))
        hash.update('\0')
        hash.update(readFileSync(child))
        hash.update('\0')
      }
    }
  }
  for (const input of inputs) {
    if (readdirSafe(input)) add(input)
    else {
      hash.update(relative(repo, input).replaceAll('\\', '/'))
      hash.update('\0')
      hash.update(readFileSync(input))
      hash.update('\0')
    }
  }
  return hash.digest('hex').slice(0, 24)
}

function readdirSafe(path) {
  try {
    readdirSync(path)
    return true
  } catch {
    return false
  }
}


// The launcher bundle needs the @earendil-works/pi-ai portion of the Harness
// pnpm store. Workspace packages are resolved through nodePaths below rather
// than through a complete flat node_modules tree, so use the store's shared
// package link as the readiness marker. This keeps incremental builds fast
// without assuming that every workspace package is hoisted to the top level.
const vendorStore = resolve(vendor, 'node_modules/.pnpm')
// The Host bundle resolves pi-ai through esbuild's nodePaths, but the child
// development DSH CLI is an unbundled ESM entry.  It therefore also needs the
// workspace links created under apps/cli/node_modules; checking only pi-ai
// allowed a partially installed checkout to build a Host whose child runtime
// immediately failed with ERR_MODULE_NOT_FOUND for dsh-app-boot.
const vendorReady = existsSync(resolve(vendorStore, 'node_modules/@earendil-works/pi-ai'))
  && existsSync(resolve(vendor, 'apps/cli/node_modules/@deepseek-ai/dsh-app-boot/package.json'))
  && existsSync(resolve(vendor, 'packages/sdk/server/node_modules/@deepseek-ai/dsh-session/package.json'))

function executable(path) {
  if (process.platform === 'win32') return existsSync(path)
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const devPnpm = resolve(root, 'scripts/tooling/pnpm')
if (existsSync(devPnpm) && !executable(devPnpm)) {
  throw new Error(`development pnpm wrapper is not executable: ${devPnpm}; run chmod +x scripts/tooling/pnpm`)
}
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

const runtimeMarkers = [
  resolve(vendor, 'apps/cli/lib/bin.js'),
  resolve(vendor, 'packages/sdk/server/lib/index.js'),
  resolve(vendor, 'packages/core/session/lib/types/index.d.ts'),
]
if (!runtimeMarkers.every(existsSync) || process.env.FLOWIX_DSH_REBUILD_LIBS === '1') {
  process.stdout.write('vendored Harness libraries are missing; building host runtime outputs...\n')
  await new Promise((done, fail) => {
    const corepackCmd = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
    const child = spawn(corepackCmd, ['pnpm@11.7.0', 'run', 'build:lib:host'], {
      cwd: vendor,
      stdio: 'inherit',
      env: buildEnv,
      shell: process.platform === 'win32',
    })
    child.once('error', fail)
    child.once('exit', code => code === 0 ? done() : fail(new Error('Harness library build exited ' + code)))
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
 * right shape for both source development and the managed production bundle.
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
