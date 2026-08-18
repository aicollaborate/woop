#!/usr/bin/env node
import { createInterface } from 'node:readline'
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
} from './protocol/validation.ts'
import { SessionPool } from './runtime/session-pool.ts'
import { catalog, discover, resolveCatalogModel } from './runtime/model-directory.ts'
import { catalog as pluginCatalog } from './runtime/plugin-directory.ts'
import { SIDECAR_BUILD_ID, SIDECAR_BUILD_ID_ENV } from './build-meta.ts'


// Refuse to start when the bundled build identity disagrees with the one the
// launcher requested. This catches stale Cargo target dirs and dev/prod mixups.
const requestedBuildId = process.env[SIDECAR_BUILD_ID_ENV]?.trim()
if (requestedBuildId !== undefined && requestedBuildId !== '' && requestedBuildId !== SIDECAR_BUILD_ID) {
  process.stderr.write(
    `[dsh-host] FATAL: bundle buildId "${SIDECAR_BUILD_ID}" disagrees with launcher request "${requestedBuildId}".\n` +
    '[dsh-host] The dsh-host bundle is out of sync with the rest of the sidecar pair; rebuild via `pnpm dsh:build`.\n',
  )
  process.exit(2)
}
if (SIDECAR_BUILD_ID === 'uninitialized' || SIDECAR_BUILD_ID === '') {
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

async function dispatch(request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'host.initialize':
      return {
        protocolVersion: HOST_PROTOCOL_VERSION,
        buildId: SIDECAR_BUILD_ID,
        host: { name: 'flowix-dsh-host', version: '1.0.0' },
        harness: { commit: '47f943859bef60e4160492346772ded9b24f765a', version: '0.1.0-rc.5' },
        capabilities: [
          'streaming',
          'reasoning',
          'tools',
          'usage',
          'session-resume',
          'cancel-by-restart',
          'model-catalog',
          'model-discovery',
          'plugin-catalog',
        ],
      }
    case 'host.ping': return { ok: true }
    case 'runtime.ensure': return await pool.ensure(requireRuntimeSpec(request.params))
    case 'runtime.status': return { runtimes: pool.status() }
    case 'runtime.dispose': return { disposed: await pool.dispose(requireThread(request.params).threadId) }
    case 'session.usage': return (await pool.usage(requireSessionUsage(request.params).sessionId)) ?? null
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
      const models = await discover({
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
    case 'plugins.catalog': return { plugins: pluginCatalog() }
    default:
      throw new ProtocolInputError(`unknown method ${request.method}`)
  }
}

interface IncomingFrame {
  jsonrpc?: string
  id?: JsonRpcId
  method?: string
  params?: unknown
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
  const request = requireRequest(frame)
  if ('error' in request) {
    writeFrame({ jsonrpc: '2.0', id: request.id ?? null, error: request.error })
    return
  }
  dispatch(request)
    .then(result => {
      writeFrame({ jsonrpc: '2.0', id: request.id, result })
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof ProtocolInputError ? -32602 : -32000
      writeFrame({ jsonrpc: '2.0', id: request.id, error: { code, message } })
    })
})

process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))