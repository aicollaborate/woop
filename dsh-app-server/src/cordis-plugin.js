import { DshAppServer } from './app-server/server.js'
import { createHttpTransport } from './app-server/transports/http.js'

export const name = 'dsh-app-server'
// Model settings/discovery are optional capabilities. Resolve them at request
// time so the core Thread/Turn server can still boot in minimal DSH profiles.
export const inject = ['agents', 'sessions']

export default function dshAppServer(ctx, config = {}) {
  if (!ctx.get?.('approval')) throw new Error('dsh-app-server requires the native DSH approval service')
  const server = new DshAppServer(ctx)
  const disposeApproval = ctx.on?.('approval/request', (request, next) => server.handleApproval(request, next))
  server.addDisposer(disposeApproval)
  const http = config.http ? createHttpTransport(server, config.http) : null
  const service = {
    dispatch: (request, connectionId) => server.dispatch(request, connectionId),
    receiveResponse: (response, connectionId) => server.receiveResponse(response, connectionId),
    createConnection: connectionId => server.createConnection(connectionId),
    subscribe: listener => server.subscribe(listener),
    subscribeConnection: (connectionId, listener) => server.subscribeConnection(connectionId, listener),
    pendingServerRequests: (connectionId, threadId) => server.pendingServerRequests(connectionId, threadId),
    listEvents: (...args) => server.listEvents(...args),
    serveStdio: () => server.serveStdio(),
    listenHttp: () => http?.listen(),
    dispose: async () => { await http?.close(); await server.dispose() }
  }
  ctx.provide('dshAppServer', service)
  if (config.stdio) server.serveStdio()
  if (http) http.listen()
  return () => service.dispose()
}
dshAppServer.inject = inject
