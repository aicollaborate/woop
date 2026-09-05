export {
  WorkColumnSurfaceHost,
  getWorkColumnSurfaceDefinition,
  surfaceSupports,
  type WorkColumnSurfaceDefinition,
} from './registry';
export { resolveWorkColumnSurface } from './resolver';
export type {
  DocumentSurfaceContext,
  DocumentSurfaceIdentity,
  PluginWorkbenchContext,
  ResolveWorkColumnSurfaceInput,
  WorkColumnSurface,
  WorkColumnSurfaceCapability,
  WorkColumnSurfaceChrome,
  WorkColumnSurfaceKind,
} from './types';

export {
  BrowserColumnSurfaceHost,
  browserColumnSurfaceRegistry,
  browserColumnSurfaceSupports,
  getBrowserColumnSurfaceDefinition,
  resolveBrowserColumnSurface,
} from './browser-column-registry';
export type {
  BrowserColumnSurface,
  BrowserColumnSurfaceCapability,
  BrowserColumnSurfaceDefinition,
  BrowserColumnSurfaceKind,
  BrowserColumnDocumentFlush,
  BrowserColumnFlushRegistration,
} from './browser-column-registry';
