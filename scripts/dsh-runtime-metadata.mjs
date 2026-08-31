import { createHash } from 'node:crypto'

export const DSH_RUNTIME_ENTRYPOINT = 'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'
export const DSH_RUNTIME_SCHEMA_VERSION = 2
export const DSH_PROTOCOL_VERSION = 1
export const DSH_PNPM_VERSION = '11.7.0'

export function createDshRuntimeMetadata({
  target,
  version,
  nodeExecutable,
  nodeVersion,
  nodeAbi,
  pnpmVersion = DSH_PNPM_VERSION,
  includePnpm = true,
  localBuild = false,
}) {
  const metadata = {
    schemaVersion: DSH_RUNTIME_SCHEMA_VERSION,
    product: 'flowix-dsh',
    version,
    protocolVersion: DSH_PROTOCOL_VERSION,
    target,
    includesUi: false,
    runtimeType: 'node-bundle',
    nodeExecutable,
    pnpmEntrypoint: 'tools/pnpm/node_modules/pnpm/bin/pnpm.mjs',
    nodeVersion,
    nodeAbi,
    pnpmVersion,
    entrypoint: DSH_RUNTIME_ENTRYPOINT,
    cliEntrypoint: DSH_RUNTIME_ENTRYPOINT,
  }
  if (!includePnpm) delete metadata.pnpmEntrypoint
  if (localBuild) metadata.localBuild = true
  metadata.buildId = createHash('sha256').update(JSON.stringify(metadata)).digest('hex').slice(0, 24)
  return metadata
}
