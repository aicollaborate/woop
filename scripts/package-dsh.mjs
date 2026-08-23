import { createHash } from 'node:crypto'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const repo = resolve(import.meta.dirname, '..')
const hostRoot = resolve(repo, 'dsh-flowix-host')
const stageRoot = resolve(repo, '.build/dsh-package')
const releaseRoot = resolve(repo, '.build/releases/dsh')
const dshBuildRoot = resolve(repo, '.build/flowix-dsh-host')
const dshPackage = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'))
const requested = process.argv.find(value => value.startsWith('--targets='))?.slice('--targets='.length)
const targets = (requested ? requested.split(',') : [hostTarget()]).filter(Boolean)
const version = process.env.FLOWIX_DSH_VERSION?.trim() || dshPackage.version
const publicBase = (process.env.FLOWIX_DSH_PUBLIC_BASE || 'https://download.flowix-memo.com').replace(/\/$/u, '')
const prefix = (process.env.FLOWIX_DSH_R2_PREFIX || `dsh/v${version}`).replace(/^\/+|\/+$/gu, '')
const requireSignature = process.env.FLOWIX_DSH_REQUIRE_SIGNATURE === '1' || process.env.DSH_PUBLISH === '1'

await rm(stageRoot, { recursive: true, force: true })
await rm(releaseRoot, { recursive: true, force: true })
await mkdir(releaseRoot, { recursive: true })
const platforms = {}

for (const target of targets) {
  const { platform, arch, triple } = targetInfo(target)
  const sourceHost = resolve(repo, `.build/flowix-dsh-host/dsh-host-${platform}-${arch}` + (platform === 'windows' ? '.exe' : ''))
  if (!existsSync(sourceHost)) {
    throw new Error(`missing DSH host for ${target}: ${sourceHost}; run npm run dsh:build first`)
  }

  const packageDir = resolve(stageRoot, target)
  await mkdir(packageDir, { recursive: true })
  await copyFile(sourceHost, join(packageDir, platform === 'windows' ? 'dsh-host.exe' : 'dsh-host'))
  const sourceHelper = resolve(dshBuildRoot, `dsh-host-spawn-helper-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`)
  if (existsSync(sourceHelper)) {
    await copyFile(sourceHelper, join(packageDir, platform === 'windows' ? 'dsh-host-spawn-helper.exe' : 'dsh-host-spawn-helper'))
  }
  await copyTree(resolve(repo, 'dsh-flowix-memory'), join(packageDir, 'dsh-flowix-memory'))
  // The host/desktop bridge is a normal DSH profile bundle. Keep it visible
  // in the standalone archive so DSH's profile loader resolves it from the
  // profile directory instead of relying on host-generated plugin source.
  await copyTree(resolve(hostRoot, 'profile/flowix'), join(packageDir, 'profile/flowix'))
  const buildIdPath = resolve(repo, '.build/flowix-dsh-host/dsh-build-id.txt')
  const buildId = existsSync(buildIdPath) ? (await readFile(buildIdPath, 'utf8')).trim() : null
  await writeFile(join(packageDir, 'dsh-runtime.json'), `${JSON.stringify({
    schemaVersion: 1,
    product: 'flowix-dsh',
    version,
    protocolVersion: 1,
    buildId,
    target,
    includesUi: false,
  }, null, 2)}\n`)

  const extension = '.tar.gz'
  const filename = `Flowix-DSH_${version}_${target}${extension}`
  const archive = resolve(releaseRoot, filename)
  run('tar', ['-czf', archive, '-C', packageDir, '.'])
  run(process.execPath, [resolve(repo, 'scripts/verify-dsh-package.mjs'), archive])
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
  let signaturePath = process.env.FLOWIX_DSH_SIGNATURE_DIR
    ? resolve(process.env.FLOWIX_DSH_SIGNATURE_DIR, `${filename}.minisig`)
    : null
  if (process.env.FLOWIX_DSH_SIGNING_PRIVATE_KEY || process.env.FLOWIX_DSH_SIGNING_PRIVATE_KEY_PATH) {
    signaturePath = resolve(releaseRoot, `${filename}.minisig`)
    await signArchive(archive, signaturePath)
  }
  if (signaturePath && existsSync(signaturePath)) row.signature = await readFile(signaturePath, 'utf8')
  if (requireSignature && !row.signature) {
    throw new Error(`missing minisign signature for ${filename}; provide FLOWIX_DSH_SIGNING_PRIVATE_KEY(_PATH) or FLOWIX_DSH_SIGNATURE_DIR`)
  }
  platforms[manifestPlatform(target)] = row
  console.log(`created ${archive}`)
}

const manifest = {
  schemaVersion: 1,
  product: 'flowix-dsh',
  version,
  protocolVersion: 1,
  minFlowixVersion: process.env.FLOWIX_MIN_VERSION || '1.2.1',
  platforms,
}
await writeFile(resolve(releaseRoot, 'dsh-latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`created ${resolve(releaseRoot, 'dsh-latest.json')}`)

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
  const platform = process.platform === 'darwin' ? 'macos' : process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `node24-${platform}-${arch}`
}

async function signArchive(archive, signaturePath) {
  let keyPath = process.env.FLOWIX_DSH_SIGNING_PRIVATE_KEY_PATH
    ? resolve(process.env.FLOWIX_DSH_SIGNING_PRIVATE_KEY_PATH)
    : null
  const password = process.env.FLOWIX_DSH_SIGNING_PRIVATE_KEY_PASSWORD
    || process.env.MINISIGN_PASSWORD
  let temporaryDir = null
  try {
    if (!keyPath) {
      temporaryDir = await mkdtemp(join(tmpdir(), 'flowix-dsh-signing-'))
      keyPath = join(temporaryDir, 'minisign.key')
      await writeFile(keyPath, `${process.env.FLOWIX_DSH_SIGNING_PRIVATE_KEY}\n`, { mode: 0o600 })
    }
    const args = ['-S', '-s', keyPath, '-m', archive, '-x', signaturePath]
    if (password) {
      const expectScript = `
        set timeout -1
        set command [list $env(FLOWIX_MINISIGN_BIN) -S -s $env(FLOWIX_MINISIGN_KEY) -m $env(FLOWIX_MINISIGN_MESSAGE) -x $env(FLOWIX_MINISIGN_SIGNATURE)]
        spawn {*}$command
        expect {
          -re {Password:} {
            send -- "$env(FLOWIX_MINISIGN_PASSWORD)\\r"
            exp_continue
          }
          eof {}
        }
        set result [wait]
        exit [lindex $result 3]
      `
      const result = spawnSync('expect', ['-c', expectScript], {
        cwd: repo,
        stdio: 'inherit',
        env: {
          ...process.env,
          FLOWIX_MINISIGN_BIN: process.env.MINISIGN_BIN || 'minisign',
          FLOWIX_MINISIGN_KEY: keyPath,
          FLOWIX_MINISIGN_MESSAGE: archive,
          FLOWIX_MINISIGN_SIGNATURE: signaturePath,
          FLOWIX_MINISIGN_PASSWORD: password,
        },
      })
      if (result.error) throw result.error
      if (result.status !== 0) throw new Error(`minisign exited with ${result.status}`)
    } else {
      run(process.env.MINISIGN_BIN || 'minisign', args)
    }
  } finally {
    if (temporaryDir) await rm(temporaryDir, { recursive: true, force: true })
  }
}

async function copyTree(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name)
    const to = join(destination, entry.name)
    if (entry.isDirectory()) await copyTree(from, to)
    else if (entry.isFile()) await copyFile(from, to)
  }
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
