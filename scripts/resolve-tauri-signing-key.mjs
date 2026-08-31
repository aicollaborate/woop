import { spawnSync } from 'node:child_process'

const DEFAULT_KEYCHAIN_SERVICE = 'com.flowix.minisign.private-key'
const DEFAULT_PASSWORD_KEYCHAIN_SERVICE = 'com.flowix.minisign'
const DEFAULT_PASSWORD_KEYCHAIN_ACCOUNT = 'flowix-shared'

/**
 * Populate TAURI_SIGNING_PRIVATE_KEY from macOS Keychain when no explicit
 * key/path was supplied. The key contents are returned only to the caller and
 * are never printed or persisted.
 */
export function resolveTauriSigningKey(environment = process.env) {
  if (process.platform !== 'darwin') return environment

  const resolved = { ...environment }
  const service = environment.TAURI_SIGNING_PRIVATE_KEY_KEYCHAIN_SERVICE?.trim()
    || DEFAULT_KEYCHAIN_SERVICE
  if (!resolved.TAURI_SIGNING_PRIVATE_KEY?.trim() && !resolved.TAURI_SIGNING_PRIVATE_KEY_PATH?.trim()) {
    const key = readKeychainValue(['-s', service])
    if (key) resolved.TAURI_SIGNING_PRIVATE_KEY = key
  }

  if (!resolved.TAURI_SIGNING_PRIVATE_KEY_PASSWORD?.trim()) {
    const passwordService = environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_KEYCHAIN_SERVICE?.trim()
      || DEFAULT_PASSWORD_KEYCHAIN_SERVICE
    const passwordAccount = environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_KEYCHAIN_ACCOUNT?.trim()
      || DEFAULT_PASSWORD_KEYCHAIN_ACCOUNT
    const password = readKeychainValue(['-s', passwordService, '-a', passwordAccount])
    if (password) resolved.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password
  }

  return resolved
}

function readKeychainValue(args) {
  const result = spawnSync('/usr/bin/security', ['find-generic-password', ...args, '-w'], {
    stdio: ['ignore', 'pipe', 'ignore'],
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

export function applyTauriSigningKey(environment = process.env) {
  const resolved = resolveTauriSigningKey(environment)
  if (resolved.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY) {
    process.env.TAURI_SIGNING_PRIVATE_KEY = resolved.TAURI_SIGNING_PRIVATE_KEY
  }
  if (resolved.TAURI_SIGNING_PRIVATE_KEY_PASSWORD && !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = resolved.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  }
  return resolved
}
