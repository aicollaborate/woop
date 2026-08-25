import type { ComponentProps } from 'react';
import type { AgentConversationDetail } from '@features/agent/components/agent-conversation-detail';
import type { DocumentContainer } from '@features/document/components/document-container';
import type { PluginDocumentView } from '@features/plugin/plugin-document-view';
import type { PluginWorkbench } from '@features/plugin/plugin-workbench';
import type { PluginArtifactRendererId } from '@features/plugin/plugin-note';
import type { MemoItem } from '@/types/memo-item';
import type { PluginDescriptor } from '@platform/tauri/client';

export type ThirdColumnSurfaceCapability =
  | 'edit'
  | 'search'
  | 'properties'
  | 'copy-content'
  | 'export-content'
  | 'save-template'
  | 'version-history'
  | 'fit'
  | 'zoom'
  | 'fullscreen'
  | 'open-source'
  | 'run-agent'
  | 'stream-conversation';

export type ThirdColumnSurfaceChrome = 'document' | 'agent';

interface SurfaceBase {
  instanceKey: string;
}

export interface MarkdownSurface extends SurfaceBase {
  kind: 'markdown';
  props: ComponentProps<typeof DocumentContainer>;
}

export interface PluginArtifactSurfaceBase extends SurfaceBase {
  props: ComponentProps<typeof PluginDocumentView>;
  renderer: PluginArtifactRendererId | null;
}

export interface MindmapSurface extends PluginArtifactSurfaceBase {
  kind: 'mindmap';
  renderer: 'markmap';
}

export interface HtmlSurface extends PluginArtifactSurfaceBase {
  kind: 'html';
  renderer: 'html' | 'webpage';
}

export interface JsonSurface extends PluginArtifactSurfaceBase {
  kind: 'json';
  renderer: 'json-viewer';
}

export interface TextSurface extends PluginArtifactSurfaceBase {
  kind: 'text';
  renderer: 'text' | 'markdown';
}

export interface PluginArtifactSurface extends PluginArtifactSurfaceBase {
  kind: 'plugin-artifact';
}

export interface AgentConversationSurface extends SurfaceBase {
  kind: 'agent-conversation';
  instanceId: ComponentProps<typeof AgentConversationDetail>['instanceId'];
}

export interface PluginWorkbenchSurface extends SurfaceBase {
  kind: 'plugin-workbench';
  props: ComponentProps<typeof PluginWorkbench>;
}

export interface WebSurface extends SurfaceBase {
  kind: 'web';
  url: string;
}

export interface EmptySurface extends SurfaceBase {
  kind: 'empty';
  message: string;
}

export type ThirdColumnSurface =
  | MarkdownSurface
  | MindmapSurface
  | HtmlSurface
  | JsonSurface
  | TextSurface
  | PluginArtifactSurface
  | AgentConversationSurface
  | PluginWorkbenchSurface
  | WebSurface
  | EmptySurface;

export type ThirdColumnSurfaceKind = ThirdColumnSurface['kind'];

export interface ResolvableDocumentSurface {
  memo: MemoItem | null;
  markdown: MarkdownSurface;
  artifact?: {
    memoId: string;
    transitionId?: number;
  };
}

export interface ResolveThirdColumnSurfaceInput {
  webUrl?: string | null;
  document?: ResolvableDocumentSurface | null;
  pluginWorkbench?: {
    plugin: PluginDescriptor;
    notebookPath: string | undefined;
    currentNotePath: string | null;
    currentNoteContent: string;
  } | null;
  agentConversationId?: string | null;
  emptyMessage: string;
}
