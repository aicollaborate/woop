#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'

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
if (runtimeEntry === undefined) throw new Error('DSH archive does not contain dsh-runtime.json')
const runtimeMetadataResult = spawnSync('tar', ['-xOzf', archive, runtimeEntry], { encoding: 'utf8' })
if (runtimeMetadataResult.status !== 0) {
  throw new Error(`cannot read dsh-runtime.json: ${runtimeMetadataResult.stderr || runtimeMetadataResult.status}`)
}
const runtimeMetadata = JSON.parse(runtimeMetadataResult.stdout)
if (runtimeMetadata.schemaVersion !== 1
  || runtimeMetadata.product !== 'flowix-dsh'
  || runtimeMetadata.protocolVersion !== 1
  || runtimeMetadata.includesUi !== false
  || typeof runtimeMetadata.version !== 'string'
  || typeof runtimeMetadata.target !== 'string'
  || typeof runtimeMetadata.buildId !== 'string'
  || runtimeMetadata.buildId.trim() === '') {
  throw new Error('dsh-runtime.json is incomplete or incompatible')
}

// `dsh:package` consumes a prebuilt target binary. Extract the complete
// archive and exercise the runtime/profile boundary, not just host.initialize;
// otherwise a stale or pruned profile can pass release verification and fail
// only when the user sends the first message.
const temporaryRoot = await mkdtemp(join(tmpdir(), 'flowix-dsh-package-'))
let healthCheckFailed = false
let probe = null
try {
  const extracted = spawnSync('tar', ['-xzf', archive, '-C', temporaryRoot], {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  if (extracted.status !== 0) {
    throw new Error(`cannot extract DSH archive: ${extracted.stderr || extracted.status}`)
  }
  const hostPath = join(temporaryRoot, hostName)
  await chmod(hostPath, 0o755)
  const dshHome = join(temporaryRoot, '.health-dsh-home')
  const sessionRoot = join(temporaryRoot, '.health-sessions')
  await mkdir(dshHome, { recursive: true })
  await writeFile(join(dshHome, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n')
  await writeFile(join(dshHome, '.credentials.yaml'), 'DSH_API_KEY: health-check\n', { mode: 0o600 })
  // On Apple Silicon, launching an x64 Mach-O directly from Node can hang
  // before the JSON-RPC process starts. Explicitly select Rosetta for the
  // cross-architecture package health check.
  const launchCommand = process.platform === 'darwin' && process.arch === 'arm64' && runtimeMetadata.target === 'node24-macos-x64'
    ? 'arch'
    : hostPath
  const launchArgs = launchCommand === 'arch' ? ['-x86_64', hostPath] : []
  probe = startJsonRpcProbe(launchCommand, launchArgs, {
    env: {
      ...process.env,
      FLOWIX_DSH_ROOT: temporaryRoot,
      FLOWIX_DSH_SESSION_ROOT: sessionRoot,
      DSH_HOME: dshHome,
      DSH_SETTINGS_PATH: join(dshHome, 'settings.yaml'),
      DSH_CREDENTIALS_PATH: join(dshHome, '.credentials.yaml'),
    },
  })
  const result = await probe.request('host.initialize', { protocolVersion: 1 })
  if (result?.protocolVersion !== 1) throw new Error('DSH host protocol version mismatch')
  const capabilities = Array.isArray(result?.capabilities) ? result.capabilities : []
  for (const capability of ['model-catalog', 'model-discovery', 'plugin-catalog', 'runtime-profile']) {
    if (!capabilities.includes(capability)) {
      throw new Error(`DSH host is outdated: missing ${capability} capability`)
    }
  }
  if (typeof result?.buildId !== 'string' || result.buildId.trim() === '') {
    throw new Error('DSH host health check did not return a buildId')
  }
  if (result.buildId !== runtimeMetadata.buildId) {
    throw new Error(`DSH buildId mismatch: metadata=${runtimeMetadata.buildId}, host=${result.buildId}`)
  }
  const threadId = 'flowix-package-health-check'
  await probe.request('runtime.ensure', {
    threadId,
    sessionId: 'flowix-package-health-session',
    cwd: temporaryRoot,
    workspacePaths: [],
    provider: 'openai',
    providerName: 'package-health-check',
    apiProtocol: 'openai-completions',
    apiKeyEnv: 'DSH_API_KEY',
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'health-check-model',
    agentPreset: 'minimal',
    permissionMode: 'read-only',
  }, 30_000)
  const bridge = await probe.request('runtime.bridge.capabilities', { threadId }, 30_000)
  if (!Array.isArray(bridge?.capabilities)
    || !bridge.capabilities.includes('runtime-events')
    || !bridge.capabilities.includes('session-control')) {
    throw new Error('DSH runtime bridge is missing baseline capabilities')
  }
  await probe.request('runtime.dispose', { threadId }, 15_000)
  await probe.request('host.shutdown', {}, 15_000)
  await probe.close()
} catch (error) {
  console.error(`ERROR: DSH host health check could not run: ${error}`)
  healthCheckFailed = true
} finally {
  await probe?.close()
  await rm(temporaryRoot, { recursive: true, force: true })
}
if (healthCheckFailed) process.exit(1)

console.log(`==> Verified headless DSH archive: ${archive}`)

function startJsonRpcProbe(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let nextId = 0
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString()}`.slice(-32_768)
  })
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { return }
    const waiter = pending.get(frame.id)
    if (waiter === undefined) return
    pending.delete(frame.id)
    clearTimeout(waiter.timer)
    if (frame.error !== undefined) waiter.reject(new Error(frame.error.message ?? JSON.stringify(frame.error)))
    else waiter.resolve(frame.result)
  })
  const failPending = message => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`${message}${stderr ? `; stderr=${stderr}` : ''}`))
    }
    pending.clear()
  }
  child.once('error', error => failPending(`DSH health-check process error: ${error}`))
  child.once('exit', code => failPending(`DSH health-check process exited with ${code}`))
  return {
    request(method, params = {}, timeout = 15_000) {
      nextId += 1
      const id = nextId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`DSH ${method} health check timed out${stderr ? `; stderr=${stderr}` : ''}`))
        }, timeout)
        pending.set(id, { resolve, reject, timer })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
          if (error === null || error === undefined) return
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        })
      })
    },
    async close() {
      if (child.exitCode !== null) return
      await new Promise(resolve => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 2_000)
        child.once('exit', () => { clearTimeout(timer); resolve() })
      })
    },
  }
}
