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
} from './protocol/validation.ts'
import { SessionPool } from './runtime/session-pool.ts'

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
        host: { name: 'flowix-dsh-host', version: '1.0.0' },
        harness: { commit: '47f943859bef60e4160492346772ded9b24f765a', version: '0.1.0-rc.5' },
        capabilities: ['streaming', 'reasoning', 'tools', 'usage', 'session-resume', 'cancel-by-restart'],
      }
    case 'host.ping': return { ok: true }
    case 'runtime.ensure': return await pool.ensure(requireRuntimeSpec(request.params))
    case 'runtime.status': return { runtimes: pool.status() }
    case 'runtime.dispose': return { disposed: await pool.dispose(requireThread(request.params).threadId) }
    case 'run.start':
      pool.startRun(requireRunStart(request.params))
      return { accepted: true }
    case 'run.cancel': {
      const params = requireThreadRun(request.params)
      return { cancelled: await pool.cancel(params.threadId, params.runId) }
    }
    case 'host.shutdown':
      await pool.close()
      setImmediate(() => process.exit(0))
      return {}
    default: throw new ProtocolInputError(-32601, `method not found: ${request.method}`)
  }
}

function respond(id: JsonRpcId, result: unknown): void {
  writeFrame({ jsonrpc: '2.0', id, result })
}

function respondError(id: JsonRpcId | null, code: number, message: string): void {
  writeFrame({ jsonrpc: '2.0', id, error: { code, message } })
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line.trim() === '') return
  let request: JsonRpcRequest
  try {
    request = requireRequest(JSON.parse(line) as unknown)
  } catch (error) {
    const code = error instanceof ProtocolInputError ? error.code : -32700
    respondError(null, code, error instanceof Error ? error.message : String(error))
    return
  }
  void dispatch(request).then(
    result => { respond(request.id, result) },
    error => {
      const code = error instanceof ProtocolInputError ? error.code : -32000
      respondError(request.id, code, error instanceof Error ? error.message : String(error))
    },
  )
})

input.on('close', () => { void pool.close().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void pool.close().finally(() => process.exit(0)) })
process.on('SIGINT', () => { void pool.close().finally(() => process.exit(130)) })

