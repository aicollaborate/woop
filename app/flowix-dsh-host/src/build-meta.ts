// Build identity for the dsh-host/dsh-runtime pair. The literal is replaced
// at bundle time by esbuild --define (see scripts/build-host.mjs and
// scripts/build-sidecars.mjs) so the same source file emits a different
// identifier for every sidecar pair shipped to users. Both sidecars embed
// the same value, which lets the launcher refuse to mix binaries that were
// built at different times.
declare const __FLOWIX_DSH_BUILD_ID__: string

export const SIDECAR_BUILD_ID: string = __FLOWIX_DSH_BUILD_ID__

export const SIDECAR_BUILD_ID_ENV = 'FLOWIX_DSH_BUILD_ID'
