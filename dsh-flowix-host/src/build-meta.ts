// Build identity embedded into the host by scripts/build-host.mjs.
declare const __FLOWIX_DSH_BUILD_ID__: string

export const HOST_BUILD_ID: string = __FLOWIX_DSH_BUILD_ID__

export const HOST_BUILD_ID_ENV = 'FLOWIX_DSH_BUILD_ID'
