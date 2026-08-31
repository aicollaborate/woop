import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveTauriSigningKey } from './resolve-tauri-signing-key.mjs'

const repo = resolve(import.meta.dirname, '..')
const artifact = process.argv[2]
if (!artifact) throw new Error('usage: node scripts/sign-updater-artifact.mjs <artifact>')
const signingEnvironment = resolveTauriSigningKey(process.env)
if (!signingEnvironment.TAURI_SIGNING_PRIVATE_KEY && !signingEnvironment.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  throw new Error('TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required')
}

const tauri = resolve(repo, 'node_modules/@tauri-apps/cli/tauri.js')
const result = spawnSync(process.execPath, [tauri, 'signer', 'sign', artifact], {
  cwd: repo,
  env: signingEnvironment,
  stdio: ['inherit', 'ignore', 'inherit'],
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

const signaturePath = `${artifact}.sig`
if (!existsSync(signaturePath)) throw new Error(`signer did not create ${signaturePath}`)
// The .sig file is already the base64-encoded Minisign/Tauri signature
// payload expected by the updater manifest. Do not encode it a second time.
const signature = (await readFile(signaturePath, 'utf8')).trim()
process.stdout.write(`${signature}\n`)
