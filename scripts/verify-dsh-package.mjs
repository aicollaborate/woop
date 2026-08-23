#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const archive = process.argv[2]
if (!archive || !existsSync(archive)) {
  console.error('usage: node scripts/verify-dsh-package.mjs <archive.tar.gz>')
  process.exit(2)
}

const result = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' })
if (result.status !== 0) {
  console.error(`ERROR: cannot inspect DSH archive: ${result.stderr || result.status}`)
  process.exit(1)
}
const entries = result.stdout.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean)
const required = [
  /dsh-host(?:\.exe)?$/iu,
  /dsh-runtime\.json$/iu,
  /dsh-flowix-memory\//iu,
  /profile\/flowix\/package\.json$/iu,
  /profile\/flowix\/node_modules\/@flowix\/dsh-flowix-bridge\/package\.json$/iu,
  /profile\/flowix\/node_modules\/@flowix\/dsh-flowix-bridge\/index\.js$/iu,
  /profile\/flowix\/node_modules\/@flowix\/dsh-flowix-bridge\/cordis\.patch\.yml$/iu,
]
const forbidden = [/dsh-web-ui/iu, /dsh-client-ui-/iu, /(?:^|[/])apps?[/].*web/iu]
const missing = required.filter((pattern) => !entries.some((entry) => pattern.test(entry)))
const unexpected = entries.filter((entry) => forbidden.some((pattern) => pattern.test(entry)))
if (missing.length || unexpected.length) {
  if (missing.length) console.error(`ERROR: DSH archive is missing: ${missing.join(', ')}`)
  if (unexpected.length) console.error(`ERROR: DSH archive unexpectedly contains UI files: ${unexpected.join(', ')}`)
  process.exit(1)
}

const profileEntry = entries.find((entry) => /profile\/flowix\/package\.json$/iu.test(entry))
const profileResult = spawnSync('tar', ['-xOzf', archive, profileEntry], { encoding: 'utf8' })
if (profileResult.status !== 0) {
  console.error(`ERROR: cannot read Flowix DSH profile manifest: ${profileResult.stderr || profileResult.status}`)
  process.exit(1)
}
try {
  const profile = JSON.parse(profileResult.stdout)
  const bundles = profile?.dsh?.profile?.bundles
  const requiredBundles = [
    '@deepseek-ai/dsh-base',
    '@flowix/dsh-flowix-bridge',
    'dsh-flowix-memory',
  ]
  if (!Array.isArray(bundles)
    || requiredBundles.some((bundle, index) => bundles[index] !== bundle)) {
    throw new Error(`expected leading bundles ${requiredBundles.join(', ')}`)
  }
} catch (error) {
  console.error(`ERROR: invalid Flowix DSH profile manifest: ${error}`)
  process.exit(1)
}

const hostName = process.platform === 'win32' ? 'dsh-host.exe' : 'dsh-host'
const hostEntry = entries.find((entry) => entry === `./${hostName}` || entry === hostName)
if (hostEntry === undefined) {
  console.error(`ERROR: DSH archive does not contain ${hostName}`)
  process.exit(1)
}

const runtimeEntry = entries.find((entry) => /(?:^|[/])dsh-runtime\.json$/iu.test(entry))
let runtimeTarget = null
if (runtimeEntry) {
  const runtimeMetadata = spawnSync('tar', ['-xOzf', archive, runtimeEntry], { encoding: 'utf8' })
  if (runtimeMetadata.status === 0) {
    try {
      runtimeTarget = JSON.parse(runtimeMetadata.stdout).target ?? null
    } catch {
      runtimeTarget = null
    }
  }
}

// `dsh:package` consumes a prebuilt target binary. A stale binary can still
// have the right filename, architecture, and protocol version while missing
// capabilities added to the host source. Run the same initialize handshake
// used by Flowix before allowing the archive to be published.
const temporaryRoot = await mkdtemp(join(tmpdir(), 'flowix-dsh-package-'))
let healthCheckFailed = false
try {
  const extracted = spawnSync('tar', ['-xOzf', archive, hostEntry], {
    encoding: 'buffer',
    maxBuffer: 512 * 1024 * 1024,
  })
  if (extracted.status !== 0 || !extracted.stdout?.length) {
    throw new Error(`cannot extract ${hostName} from DSH archive: ${extracted.stderr || extracted.status}`)
  }
  const hostPath = join(temporaryRoot, hostName)
  await writeFile(hostPath, extracted.stdout, { mode: 0o755 })
  // On Apple Silicon, launching an x64 Mach-O directly from Node can hang
  // before the JSON-RPC process starts. Explicitly select Rosetta for the
  // cross-architecture package health check.
  const launchCommand = process.platform === 'darwin' && process.arch === 'arm64' && runtimeTarget === 'node24-macos-x64'
    ? 'arch'
    : hostPath
  const launchArgs = launchCommand === 'arch' ? ['-x86_64', hostPath] : []
  const healthTimeout = launchCommand === 'arch' ? 60_000 : 15_000
  const initialize = spawnSync(launchCommand, launchArgs, {
    input: '{"jsonrpc":"2.0","id":1,"method":"host.initialize","params":{"protocolVersion":1}}\n',
    encoding: 'utf8',
    timeout: healthTimeout,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      FLOWIX_DSH_SESSION_ROOT: temporaryRoot,
      DSH_HOME: join(temporaryRoot, 'dsh-home'),
    },
  })
  if (initialize.error || initialize.status !== 0) {
    throw new Error(`DSH host health check failed: ${initialize.error || initialize.stderr || initialize.status}`)
  }
  const frame = JSON.parse(initialize.stdout.trim().split(/\r?\n/u)[0])
  const result = frame?.result
  const capabilities = Array.isArray(result?.capabilities) ? result.capabilities : []
  for (const capability of ['model-catalog', 'model-discovery', 'plugin-catalog', 'runtime-profile']) {
    if (!capabilities.includes(capability)) {
      throw new Error(`DSH host is outdated: missing ${capability} capability`)
    }
  }
  if (typeof result?.buildId !== 'string' || result.buildId.trim() === '') {
    throw new Error('DSH host health check did not return a buildId')
  }
} catch (error) {
  console.error(`ERROR: DSH host health check could not run: ${error}`)
  healthCheckFailed = true
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
if (healthCheckFailed) process.exit(1)

console.log(`==> Verified headless DSH archive: ${archive}`)
