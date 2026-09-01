export function runtimeMethods(adapter) {
  const capabilities = () => adapter.capabilitiesReport()
  const status = () => ({ protocolVersion: 1, ...adapter.statusReport() })
  return {
    'runtime/capabilities': capabilities,
    'runtime/status': status,
  }
}
