export const ErrorCode = Object.freeze({
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  notInitialized: -32002,
  alreadyInitialized: -32003,
})

export function success(id, result) {
  return { jsonrpc: '2.0', id, result }
}

export function failure(id, message, code = ErrorCode.internalError, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}

export function assertRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new RpcError(ErrorCode.invalidRequest, 'Invalid request')
  if (request.jsonrpc !== undefined && request.jsonrpc !== '2.0') throw new RpcError(ErrorCode.invalidRequest, 'jsonrpc must be "2.0" when provided')
  if (typeof request.method !== 'string' || request.method === '') throw new RpcError(ErrorCode.invalidRequest, 'method must be a non-empty string')
  if (request.id === undefined || (typeof request.id !== 'string' && typeof request.id !== 'number')) throw new RpcError(ErrorCode.invalidRequest, 'id must be a string or number')
}

export class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data }
}

export function requiredString(value, name) {
  if (typeof value !== 'string' || value === '') throw new RpcError(ErrorCode.invalidParams, `${name} must be a non-empty string`)
  return value
}

export function paramsOf(request) {
  if (request.params === undefined) return {}
  if (!request.params || typeof request.params !== 'object' || Array.isArray(request.params)) throw new RpcError(ErrorCode.invalidParams, 'params must be an object')
  return request.params
}
