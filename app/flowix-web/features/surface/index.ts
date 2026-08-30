export {
  ThirdColumnSurfaceHost,
  getThirdColumnSurfaceDefinition,
  surfaceSupports,
  type ThirdColumnSurfaceDefinition,
} from './registry';
export { resolveTabSurface, resolveWorkspaceSurface } from './resolver';
export type {
  DocumentSurfaceContext,
  DocumentSurfaceIdentity,
  PluginWorkbenchContext,
  ResolveTabSurfaceInput,
  ResolveWorkspaceSurfaceInput,
  ThirdColumnSurface,
  ThirdColumnSurfaceCapability,
  ThirdColumnSurfaceChrome,
  ThirdColumnSurfaceKind,
  TabSurfaceTarget,
  TabDocumentTarget,
} from './types';
