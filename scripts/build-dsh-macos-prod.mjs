import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') throw new Error('macOS DSH builds must run on macOS')
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error(`DSH macOS builds require Node 24; current runtime is ${process.version}`)
}

const script = fileURLToPath(new URL('./build-dsh-prod.mjs', import.meta.url))
const targets = process.arch === 'arm64' ? ['arm64', 'x64'] : ['x64']
for (const arch of targets) {
  const args = [script, `--target=node24-macos-${arch}`]
  const x64Node = process.env.FLOWIX_DSH_X64_NODE?.trim() || 'node'
  const command = arch === 'x64' && process.arch === 'arm64'
    ? ['arch', ['-x86_64', x64Node, ...args]]
    : [process.execPath, args]
  const result = spawnSync(command[0], command[1], { cwd: process.cwd(), env: process.env, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command[0]} DSH ${arch} build exited with ${result.status}`)
}

console.log(`created all macOS DSH production targets: ${targets.join(', ')}`)
