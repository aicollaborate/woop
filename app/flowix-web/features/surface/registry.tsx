'use client';

import {
  lazy,
  Suspense,
  type ComponentType,
  type ReactNode,
} from 'react';
import { DocumentContainer } from '@features/document/components/document-container';
import backgroundImage from '@/assets/bg.document.png';
import { useI18n } from '@/lib/i18n';
import type {
  AgentConversationSurface,
  EmptySurface,
  MarkdownSurface,
  PluginArtifactSurfaceBase,
  PluginWorkbenchSurface,
  ThirdColumnSurface,
  ThirdColumnSurfaceCapability,
  ThirdColumnSurfaceChrome,
  ThirdColumnSurfaceKind,
  WebSurface,
} from './types';

type SurfaceOfKind<K extends ThirdColumnSurfaceKind> = Extract<ThirdColumnSurface, { kind: K }>;

const AgentConversationDetail = lazy(() =>
  import('@features/agent/components/agent-conversation-detail').then((module) => ({
    default: module.AgentConversationDetail,
  })),
);
const PluginDocumentView = lazy(() =>
  import('@features/plugin/plugin-document-view').then((module) => ({
    default: module.PluginDocumentView,
  })),
);
const PluginWorkbench = lazy(() =>
  import('@features/plugin/plugin-workbench').then((module) => ({
    default: module.PluginWorkbench,
  })),
);

function SurfaceLoadingFallback() {
  const { t } = useI18n();
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
      {t('memo.navigation.loading')}
    </div>
  );
}

export interface ThirdColumnSurfaceDefinition {
  chrome: ThirdColumnSurfaceChrome;
  capabilities: readonly ThirdColumnSurfaceCapability[];
  render: (surface: ThirdColumnSurface) => ReactNode;
}

function defineSurface<K extends ThirdColumnSurfaceKind>(
  kind: K,
  options: {
    chrome: ThirdColumnSurfaceChrome;
    capabilities?: readonly ThirdColumnSurfaceCapability[];
    component: ComponentType<{ surface: SurfaceOfKind<K> }>;
  },
): ThirdColumnSurfaceDefinition {
  const Component = options.component;
  return Object.freeze({
    chrome: options.chrome,
    capabilities: Object.freeze([...(options.capabilities ?? [])]),
    render(surface: ThirdColumnSurface) {
      if (surface.kind !== kind) {
        throw new Error(`Surface registry mismatch: expected '${kind}', received '${surface.kind}'`);
      }
      // TypeScript cannot correlate a generic discriminant with Extract after
      // the runtime guard. Keep the assertion inside this constructor so all
      // registry consumers remain exhaustively typed.
      return <Component surface={surface as SurfaceOfKind<K>} />;
    },
  });
}

function MarkdownSurfaceView({ surface }: { surface: MarkdownSurface }) {
  return <DocumentContainer {...surface.props} />;
}

function PluginArtifactSurfaceView({ surface }: { surface: PluginArtifactSurfaceBase }) {
  return (
    <Suspense fallback={<SurfaceLoadingFallback />}>
      <PluginDocumentView {...surface.props} />
    </Suspense>
  );
}

function AgentConversationSurfaceView({ surface }: { surface: AgentConversationSurface }) {
  return (
    <Suspense fallback={<SurfaceLoadingFallback />}>
      <AgentConversationDetail instanceId={surface.instanceId} />
    </Suspense>
  );
}

function PluginWorkbenchSurfaceView({ surface }: { surface: PluginWorkbenchSurface }) {
  return (
    <Suspense fallback={<SurfaceLoadingFallback />}>
      <PluginWorkbench {...surface.props} />
    </Suspense>
  );
}

function WebSurfaceView({ surface }: { surface: WebSurface }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--muted-foreground)]">
      {surface.url}
    </div>
  );
}

function EmptySurfaceView({ surface }: { surface: EmptySurface }) {
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-no-repeat bg-bottom bg-[length:auto_800px] opacity-[0.32]"
        style={{ backgroundImage: `url(${backgroundImage})` }}
      />
      <span className="relative text-center text-sm text-[var(--muted-foreground)]">
        {surface.message}
      </span>
    </div>
  );
}

const artifactBaseCapabilities = ['fullscreen'] as const;

export const thirdColumnSurfaceRegistry = Object.freeze({
  markdown: defineSurface('markdown', {
    chrome: 'document',
    capabilities: [
      'edit',
      'search',
      'properties',
      'copy-content',
      'export-content',
      'save-template',
      'version-history',
    ],
    component: MarkdownSurfaceView,
  }),
  mindmap: defineSurface('mindmap', {
    chrome: 'document',
    capabilities: [...artifactBaseCapabilities, 'fit', 'zoom'],
    component: PluginArtifactSurfaceView,
  }),
  html: defineSurface('html', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  json: defineSurface('json', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  text: defineSurface('text', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  'plugin-artifact': defineSurface('plugin-artifact', {
    chrome: 'document',
    capabilities: artifactBaseCapabilities,
    component: PluginArtifactSurfaceView,
  }),
  'agent-conversation': defineSurface('agent-conversation', {
    chrome: 'agent',
    capabilities: ['stream-conversation'],
    component: AgentConversationSurfaceView,
  }),
  'plugin-workbench': defineSurface('plugin-workbench', {
    chrome: 'document',
    capabilities: ['run-agent', 'fullscreen'],
    component: PluginWorkbenchSurfaceView,
  }),
  web: defineSurface('web', {
    chrome: 'document',
    component: WebSurfaceView,
  }),
  empty: defineSurface('empty', {
    chrome: 'document',
    component: EmptySurfaceView,
  }),
} satisfies Record<ThirdColumnSurfaceKind, ThirdColumnSurfaceDefinition>);

export function getThirdColumnSurfaceDefinition(
  surface: ThirdColumnSurface,
): ThirdColumnSurfaceDefinition {
  return thirdColumnSurfaceRegistry[surface.kind];
}

export function surfaceSupports(
  surface: ThirdColumnSurface,
  capability: ThirdColumnSurfaceCapability,
): boolean {
  return getThirdColumnSurfaceDefinition(surface).capabilities.includes(capability);
}

function ThirdColumnSurfaceMount({ surface }: { surface: ThirdColumnSurface }) {
  return getThirdColumnSurfaceDefinition(surface).render(surface);
}

export function ThirdColumnSurfaceHost({ surface }: { surface: ThirdColumnSurface }) {
  return (
    <ThirdColumnSurfaceMount
      key={`${surface.kind}:${surface.instanceKey}`}
      surface={surface}
    />
  );
}
