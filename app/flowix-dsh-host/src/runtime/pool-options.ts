/** Retention policy for completed per-thread Harness runtime processes. */
export interface SessionPoolOptions {
  maxIdleRuntimes: number
  idleTtlMs: number
}

const DEFAULT_MAX_IDLE_RUNTIMES = 2
const DEFAULT_IDLE_TTL_MS = 5 * 60_000

/** Resolve deployment-tunable runtime retention settings from the host environment. */
export function sessionPoolOptions(env: NodeJS.ProcessEnv = process.env): SessionPoolOptions {
  return {
    maxIdleRuntimes: nonNegativeInteger(env.FLOWIX_DSH_MAX_IDLE_RUNTIMES, DEFAULT_MAX_IDLE_RUNTIMES),
    idleTtlMs: nonNegativeInteger(env.FLOWIX_DSH_IDLE_TTL_MS, DEFAULT_IDLE_TTL_MS),
  }
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  if (!/^\d+$/.test(value)) throw new Error(`expected a non-negative integer, received ${JSON.stringify(value)}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`integer is outside the safe range: ${value}`)
  return parsed
}
