import { lazy, type ComponentProps } from 'react';

/**
 * Keep the conversation detail behind one runtime boundary.
 *
 * The main workspace and Browser Column can both render an Agent conversation,
 * but neither surface should pull the Thread Card implementation into the
 * desktop startup graph. Keeping the lazy component here also makes the
 * import promise shared and cached across both surfaces.
 */
type AgentConversationDetailProps = ComponentProps<
  typeof import('./agent-conversation-detail').AgentConversationDetail
>;

export const LazyAgentConversationDetail = lazy(() =>
  import('./agent-conversation-detail').then((module) => ({
    default: module.AgentConversationDetail,
  })),
);

export type { AgentConversationDetailProps };
