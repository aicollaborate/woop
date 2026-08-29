import { createServer } from 'node:http'
import { ErrorCode, failure } from '../protocol/json-rpc.js'

/** HTTP JSON-RPC transport for hosts that cannot use stdio. */
export function createHttpTransport(appServer, { host = '127.0.0.1', port = 0, maxBodyBytes = 1024 * 1024 } = {}) {
  const subscribers = new Map()
  const server = createServer(async (request, response) => {
    if (request.url === '/readyz' && request.method === 'GET') { response.writeHead(200); response.end('ready'); return }
    if (request.url === '/healthz' && request.method === 'GET') {
      if (request.headers.origin) { response.writeHead(403); response.end(); return }
      response.writeHead(200); response.end('ok'); return
    }
    if (request.method === 'GET' && request.url?.startsWith('/events')) {
      const query = new URL(request.url, 'http://localhost').searchParams
      const threadId = query.get('threadId')
      const clientId = query.get('clientId') || request.headers['x-dsh-client-id'] || 'http-default'
      const afterSeq = Number(query.get('afterSeq') ?? -1)
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const id = String(clientId)
      appServer.reconnectConnection?.(id)
      const unsubscribe = appServer.subscribeConnection?.(id, event => {
        const eventThreadId = event.params?.threadId || event.params?.thread?.id
        if (!threadId || !eventThreadId || threadId === eventThreadId) response.write(`data: ${JSON.stringify(event)}\n\n`)
      }) || (() => {})
      subscribers.set(response, { threadId, clientId: id, unsubscribe })
      if (threadId && typeof appServer.replayNotifications === 'function') {
        try {
          const page = await appServer.replayNotifications(threadId, Number.isFinite(afterSeq) ? afterSeq : -1, Number(query.get('limit') ?? 200))
          for (const event of page.data || []) response.write(`data: ${JSON.stringify(event)}\n\n`)
        } catch (error) { response.write(`event: error\ndata: ${JSON.stringify({ message: String(error) })}\n\n`) }
      }
      for (const event of appServer.pendingServerRequests?.(id, threadId) || []) response.write(`data: ${JSON.stringify(event)}\n\n`)
      request.on('close', () => {
        const subscription = subscribers.get(response)
        subscription?.unsubscribe?.()
        subscribers.delete(response)
        appServer.disconnectConnection?.(id, 5000)
      })
      return
    }
    if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404); response.end(); return }
    let size = 0; const chunks = []
    for await (const chunk of request) { size += chunk.length; if (size > maxBodyBytes) { response.writeHead(413); response.end(); return } chunks.push(chunk) }
    try {
      let requestBody
      try { requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { requestBody = null }
      const clientId = String(request.headers['x-dsh-client-id'] || 'http-default')
      const result = requestBody === null ? failure(null, 'Invalid JSON', ErrorCode.parseError) : await appServer.dispatch(requestBody, clientId)
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(result))
    } catch (error) { response.writeHead(500, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: String(error) })) }
  })
  return { server, listen: () => new Promise(resolve => server.listen(port, host, () => resolve(server.address()))), close: async () => { for (const [response, subscription] of subscribers) { subscription.unsubscribe?.(); response.end() } await new Promise(resolve => server.close(resolve)) } }
}
