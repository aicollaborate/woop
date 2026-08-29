export function credentialMethods(adapter) {
  const describe = p => adapter.describeCredentials(p.reference)
  const set = p => adapter.setCredential(p.reference, p.value)
  const unset = p => adapter.unsetCredential(p.reference)
  return {
    'credential/read': describe,
    'credential/set': set,
    'credential/unset': unset,
    'credentials/describe': describe,
    'credentials/set': set,
    'credentials/unset': unset,
    'flowix.bridge.credentials.describe': describe,
    'flowix.bridge.credentials.set': set,
    'flowix.bridge.credentials.unset': unset,
  }
}
