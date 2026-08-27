#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HOST_PROTOCOL_VERSION, type JsonRpcId, type JsonRpcRequest, type RunEventNotification } from './protocol/v1.ts'
import {
  ProtocolInputError,
  requireRequest,
  requireRunStart,
  requireRuntimeSpec,
  requireThread,
  requireThreadRun,
  requireModelDiscover,
  requireModelResolve,
  requireSessionUsage,
  requireSessionHistory,
  requireCredentialReference,
  requireCredentialSet,
  requireModelSettingsWrite,
} from './protocol/validation.ts'
import { SessionPool } from './runtime/session-pool.ts'
import { catalog, resolveCatalogModel } from './runtime/model-directory.ts'
import { catalog as pluginCatalog } from './runtime/plugin-directory.ts'
import { ensureFlowixProfile } from './runtime/environment.ts'
import { HOST_BUILD_ID, HOST_BUILD_ID_ENV } from './build-meta.ts'
import { RuntimeAdmin } from './runtime/admin.ts'

// The development CJS host delegates the `dsh` carrier to the built official
// CLI. Production SEA builds make the same delegation in their upstream
// dispatcher; in both cases plugin semantics remain upstream-owned.
if (process.env.DSH_EMBEDDED_CLI_MODE === '1') {
  const root = process.env.FLOWIX_DSH_ROOT ?? dirname(resolve(process.argv[1] ?? process.execPath))
  const cli = join(root, 'vendor/deepseek-harness/apps/cli/lib/bin.js')
  if (!existsSync(cli)) {
    process.stderr.write(`[dsh] official CLI is not bundled at ${cli}\n`)
    process.exit(127)
  }
  const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, DSH_EMBEDDED_CLI_MODE: undefined },
  })
  process.exit(result.status ?? 1)
}


// Refuse to start when the development launcher selected stale host output.
const requestedBuildId = process.env[HOST_BUILD_ID_ENV]?.trim()
if (requestedBuildId !== undefined && requestedBuildId !== '' && requestedBuildId !== HOST_BUILD_ID) {
  process.stderr.write(
    `[dsh-host] FATAL: bundle buildId "${HOST_BUILD_ID}" disagrees with launcher request "${requestedBuildId}".\n` +
    '[dsh-host] Rebuild via `npm run dsh:build:dev`.\n',
  )
  process.exit(2)
}
if (HOST_BUILD_ID === 'uninitialized' || HOST_BUILD_ID === '') {
  process.stderr.write('[dsh-host] FATAL: build id is empty; the bundle was produced without a build identity.\n')
  process.exit(2)
}
let writeChain = Promise.resolve()
function writeFrame(frame: unknown): void {
  writeChain = writeChain.then(async () => {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(`${JSON.stringify(frame)}\n`, error => error === null ? resolve() : reject(error))
    })
  }).catch(error => {
    process.stderr.write(`[dsh-host] stdout write failed: ${String(error)}\n`)
    process.exitCode = 1
  })
}

const pool = new SessionPool((params: RunEventNotification) => {
  writeFrame({ jsonrpc: '2.0', method: 'run.event', params })
})
const admin = new RuntimeAdmin()

async function dispatch(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'host.initialize':
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildId: HOST_BUILD_ID,
        host: { name: 'flowix-dsh-host', version: '1.0.0' },
        harness: { commit: 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e', version: '0.1.1-rc.2' },
        capabilities: [
          'streaming',
          'reasoning',
          'tools',
          'usage',
          'session-resume',
          'session-history',
          'cancel-by-restart',
          'model-catalog',
          'model-discovery',
          'plugin-catalog',
          'runtime-profile',
          'runtime-bridge',
          'credentials-management',
          'model-settings-management',
        ],
      }
    case 'host.ping': return { ok: true }
    case 'runtime.ensure': return await pool.ensure(requireRuntimeSpec(request.params))
    case 'runtime.status': return { runtimes: pool.status() }
    case 'runtime.dispose': return { disposed: await pool.dispose(requireThread(request.params).threadId) }
    case 'session.usage': return (await pool.usage(requireSessionUsage(request.params).sessionId)) ?? null
    case 'session.history': {
      const params = requireSessionHistory(request.params)
      return await pool.history(params.sessionId, params.beforeSequence, params.limit, params.snapshotSequence)
    }
    case 'runtime.bridge.capabilities': {
      const params = requireThread(request.params)
      return await pool.bridgeCapabilities(params.threadId)
    }
    case 'runtime.bridge.status': {
      const params = requireThread(request.params)
      return await pool.bridgeStatus(params.threadId)
    }
    case 'runtime.bridge.jobs.list': {
      const params = requireThread(request.params)
      return await pool.backgroundJobs(params.threadId)
    }
    case 'run.start':
      pool.startRun(requireRunStart(request.params))
      return { accepted: true }
    case 'run.cancel': {
      const params = requireThreadRun(request.params)
      return { cancelled: await pool.cancel(params.threadId, params.runId) }
    }
    case 'models.catalog': return { providers: catalog() }
    case 'models.discover': {
      const params = requireModelDiscover(request.params)
      const models = await admin.modelsDiscover({
        ...(params.provider === undefined ? {} : { provider: params.provider }),
        ...(params.baseUrl === undefined ? {} : { baseURL: params.baseUrl }),
        ...(params.api === undefined ? {} : { api: params.api }),
        ...(params.apiKey === undefined ? {} : { apiKey: params.apiKey }),
      })
      return { models }
    }
    case 'models.resolve': {
      const params = requireModelResolve(request.params)
      return { model: resolveCatalogModel(params.provider, params.model) }
    }
    case 'credentials.status': {
      const params = requireCredentialReference(request.params)
      return await admin.credentialDescribe(params.reference)
    }
    case 'credentials.set': {
      const params = requireCredentialSet(request.params)
      return await admin.credentialSet(params.reference, params.value)
    }
    case 'credentials.delete': {
      const params = requireCredentialReference(request.params)
      return await admin.credentialUnset(params.reference)
    }
    case 'settings.models.describe': return await admin.modelsDescribe()
    case 'settings.models.upsert': {
      const params = requireModelSettingsWrite(request.params, true)
      return await admin.modelUpsert(params.route, params.profile!, params.expectedRevision)
    }
    case 'settings.models.remove': {
      const params = requireModelSettingsWrite(request.params, false)
      return await admin.modelRemove(params.route, params.expectedRevision)
    }
    case 'plugins.catalog':
      ensureFlowixProfile()
      return { plugins: pluginCatalog() }
    case 'host.shutdown':
      await Promise.allSettled([pool.close(), admin.close()])
      setImmediate(() => process.exit(0))
      return { ok: true }
    default:
      throw new ProtocolInputError(-32601, `method not found: ${request.method}`)
  }
}

interface IncomingFrame {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
}

function responseId(frame: unknown): JsonRpcId | null {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return null
  const id = (frame as { id?: unknown }).id
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id as JsonRpcId | null
  return null
}

function errorResponse(id: JsonRpcId | null, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const code = error instanceof ProtocolInputError ? error.code : -32000
  writeFrame({ jsonrpc: '2.0', id, error: { code, message } })
}

const reader = createInterface({ input: process.stdin })
reader.on('line', (line: string) => {
  const trimmed = line.trim()
  if (trimmed === '') return
  let frame: IncomingFrame
  try {
    frame = JSON.parse(trimmed) as IncomingFrame
  } catch (error) {
    writeFrame({ jsonrpc: '2.0', id: null, error: { code: -32700, message: `parse error: ${String(error)}` } })
    return
  }
  let request: JsonRpcRequest
  try {
    request = requireRequest(frame)
  } catch (error) {
    errorResponse(responseId(frame), error)
    return
  }

  dispatch(request)
    .then(result => {
      writeFrame({ jsonrpc: '2.0', id: request.id, result })
    })
    .catch(error => errorResponse(request.id, error))
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
