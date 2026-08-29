import { createInterface } from 'node:readline'
import { ErrorCode, failure } from '../protocol/json-rpc.js'

export function serveStdio(appServer, input = process.stdin, output = process.stdout) {
  const connection = appServer.createConnection()
  const unsubscribe = connection.subscribe(event => output.write(`${JSON.stringify(event)}\n`))
  const lines = createInterface({ input })
  let inputQueue = Promise.resolve()
  lines.on('line', line => {
    if (!line.trim()) return
    let request
    try { request = JSON.parse(line) } catch { output.write(`${JSON.stringify(failure(null, 'Invalid JSON', ErrorCode.parseError))}\n`); return }
    if (request && request.id !== undefined && request.method === undefined) {
      connection.receive(request)
      return
    }
    // Codex clients acknowledge initialize with a notification. It has no response.
    if (request?.method === 'initialized' && request.id === undefined) return
    inputQueue = inputQueue.then(() => connection.dispatch(request)).then(response => {
      output.write(`${JSON.stringify(response)}\n`)
      // Kept for compatibility with existing DSH clients; Codex clients may ignore it.
      if (response.result && request.method === 'initialize') output.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`)
      if (request.method === 'shutdown' && response.result) {
        unsubscribe()
        connection.close()
        lines.close()
        return appServer.dispose()
      }
    }).catch(error => output.write(`${JSON.stringify(failure(request?.id ?? null, String(error)))}\n`))
  })
  return () => { unsubscribe(); connection.close(); lines.close() }
}
