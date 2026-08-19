// Build identity for the dual-mode DSH SEA (host and runtime share one
// binary; FLOWIX_DSH_RUNTIME_MODE=1 picks the runtime branch). The literal
// is replaced at bundle time by esbuild --define (see scripts/build-host.mjs
// and scripts/build-sidecars.mjs) so each sidecar embeds a fresh identifier
// for the launchers build-id check.
declare const __FLOWIX_DSH_BUILD_ID__: string

export const SIDECAR_BUILD_ID: string = __FLOWIX_DSH_BUILD_ID__

export const SIDECAR_BUILD_ID_ENV = 'FLOWIX_DSH_BUILD_ID'
