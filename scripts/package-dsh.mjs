import { createHash } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const hostRoot = resolve(repo, 'dsh-flowix-host')
const stageRoot = resolve(repo, '.build/dsh-package')
const releaseRoot = resolve(repo, '.build/releases/dsh')
const dshPackage = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'))
const privatePnpmVersion = '11.7.0'
const requested = process.argv.find(value => value.startsWith('--targets='))?.slice('--targets='.length)
const targets = (requested ? requested.split(',') : [hostTarget()]).filter(Boolean)
const version = process.env.FLOWIX_DSH_VERSION?.trim() || dshPackage.version
const publicBase = (process.env.FLOWIX_DSH_PUBLIC_BASE || 'https://download.flowix-memo.com').replace(/\/$/u, '')
const prefix = (process.env.FLOWIX_DSH_R2_PREFIX || `dsh/v${version}`).replace(/^\/+|\/+$/gu, '')

await rm(stageRoot, { recursive: true, force: true })
await rm(releaseRoot, { recursive: true, force: true })
await mkdir(releaseRoot, { recursive: true })
const platforms = {}

for (const target of targets) {
  const { platform } = targetInfo(target)
  const bundleSource = resolve(repo, `.build/dsh-runtime-bundle/${target}`)
  const isNodeBundle = existsSync(resolve(bundleSource, 'node/node'))
  if (!isNodeBundle) {
    throw new Error(`missing managed DSH bundle for ${target}; run npm run dsh:build:prod -- --target=${target}`)
  }
  const bundleBuild = JSON.parse(await readFile(resolve(bundleSource, 'runtime-build.json'), 'utf8'))
  if (bundleBuild.target !== target) {
    throw new Error(`runtime build identity mismatch: requested ${target}, bundle contains ${bundleBuild.target}`)
  }

  const packageDir = resolve(stageRoot, target)
  await mkdir(packageDir, { recursive: true })
  await copyTree(bundleSource, packageDir)
  const buildIdPath = resolve(repo, '.build/flowix-dsh-host/dsh-build-id.txt')
  const buildId = existsSync(buildIdPath) ? (await readFile(buildIdPath, 'utf8')).trim() : null
  await writeFile(join(packageDir, 'dsh-runtime.json'), `${JSON.stringify({
    schemaVersion: 2,
    product: 'flowix-dsh',
    version,
    protocolVersion: 1,
    buildId,
    target,
    includesUi: false,
    runtimeType: 'node-bundle',
      nodeExecutable: platform === 'windows' ? 'node/node.exe' : 'node/node',
      entrypoint: 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
      cliEntrypoint: 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js',
      pnpmEntrypoint: 'tools/pnpm/node_modules/pnpm/bin/pnpm.mjs',
      nodeVersion: bundleBuild.nodeVersion,
      nodeAbi: bundleBuild.nodeAbi,
      pnpmVersion: bundleBuild.pnpmVersion ?? privatePnpmVersion,
  }, null, 2)}\n`)

  const extension = '.tar.gz'
  const filename = `Flowix-DSH_${version}_${target}${extension}`
  const archive = resolve(releaseRoot, filename)
  // Git Bash's tar treats a Windows drive-letter path as a remote target.
  // Keep the archive path relative to the repository so the same packaging
  // flow works from PowerShell and Git Bash on Windows.
  run('tar', ['-czf', relative(repo, archive), '-C', packageDir, '.'])
  run(process.execPath, [resolve(repo, 'scripts/verify-dsh-package.mjs'), relative(repo, archive), packageDir])
  const bytes = await readFile(archive)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const row = {
    // R2 custom domains can retain an old object at a versioned key in the
    // edge cache after an overwrite. Make each manifest URL content-addressed
    // so clients fetch the newly published bytes immediately.
    url: `${publicBase}/${prefix}/${filename}?sha256=${sha256}`,
    sha256,
    sizeBytes: bytes.length,
    buildId,
  }
  platforms[manifestPlatform(target)] = row
  console.log(`created ${archive}`)
}

const manifest = {
  // Keep the published manifest at schema 1 until all released Flowix
  // clients accept schema 2. The archive metadata may independently use
  // schema 2; current clients already accept both metadata versions.
  schemaVersion: 1,
  product: 'flowix-dsh',
  version,
  protocolVersion: 1,
  minFlowixVersion: process.env.FLOWIX_MIN_VERSION || '1.2.1',
  platforms,
}
await writeFile(resolve(releaseRoot, 'dsh-latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`created ${resolve(releaseRoot, 'dsh-latest.json')}`)

const groupedPlatforms = {}
for (const [platform, artifact] of Object.entries(platforms)) {
  const group = platform.startsWith('darwin-') ? 'macos'
    : platform.startsWith('windows-') ? 'windows'
      : platform.startsWith('linux-') ? 'linux' : platform
  groupedPlatforms[group] ??= {}
  groupedPlatforms[group][platform] = artifact
}
for (const [group, grouped] of Object.entries(groupedPlatforms)) {
  const platformManifest = { ...manifest, platforms: grouped }
  const output = resolve(releaseRoot, 'platforms', group, 'latest.json')
  await mkdir(resolve(releaseRoot, 'platforms', group), { recursive: true })
  await writeFile(output, `${JSON.stringify(platformManifest, null, 2)}\n`)
  console.log(`created ${output}`)
}

function targetInfo(target) {
  const match = /^node24-(macos|linux|windows)-(x64|arm64)$/u.exec(target)
  if (!match) throw new Error(`unsupported DSH target: ${target}`)
  const [, platform, architecture] = match
  const arch = platform === 'windows' ? 'x64' : architecture
  const triple = platform === 'macos'
    ? `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
    : platform === 'windows'
      ? 'x86_64-pc-windows-msvc'
      : `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`
  return { platform, arch, triple }
}

function manifestPlatform(target) {
  const { platform, arch } = targetInfo(target)
  const normalizedArch = arch === 'x64' ? 'x86_64' : 'aarch64'
  return `${platform === 'macos' ? 'darwin' : platform}-${normalizedArch}`
}

function hostTarget() {
  const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `node24-${platform}-${arch}`
}

async function copyTree(source, destination) {
  await cp(source, destination, { recursive: true, force: true, dereference: true })
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    stdio: options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    input: options.input,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`)
}
