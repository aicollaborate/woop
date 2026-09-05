import type { AgentConversationInstance } from '@features/agent/store/agent-conversation-types';

export type ConversationListCursor = {
  updatedAt: number;
  instanceId: string;
};

export type ConversationPageState = {
  itemsByIdentity: Readonly<Record<string, AgentConversationInstance>>;
  orderedIdentities: readonly string[];
};

export const EMPTY_CONVERSATION_PAGE_STATE: ConversationPageState = {
  itemsByIdentity: {},
  orderedIdentities: [],
};

export function getConversationIdentity(instance: AgentConversationInstance): string {
  return instance.threadId ? `thread:${instance.threadId}` : `instance:${instance.instanceId}`;
}

function compareConversationOrder(
  left: AgentConversationInstance,
  right: AgentConversationInstance,
): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt;
  if (left.instanceId === right.instanceId) return 0;
  // SQLite's default TEXT collation is byte-wise for these ASCII ids. Keep
  // the client comparator byte-compatible with the backend cursor predicate.
  return right.instanceId < left.instanceId ? -1 : 1;
}

function isFallbackTitle(instance: AgentConversationInstance): boolean {
  const title = instance.title.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!title) return true;
  return new Set([
    `${instance.agentType} session`,
    `${instance.agentType} 会话`,
    'codex session',
    'codex 会话',
    'claude code session',
    'claude code 会话',
    'hermes session',
    'hermes 会话',
    'opencode session',
    'opencode 会话',
    'openclaw session',
    'openclaw 会话',
  ]).has(title);
}

function preferConversationInstance(
  current: AgentConversationInstance,
  candidate: AgentConversationInstance,
): AgentConversationInstance {
  const currentFallback = isFallbackTitle(current);
  const candidateFallback = isFallbackTitle(candidate);
  if (currentFallback !== candidateFallback) return currentFallback ? candidate : current;
  if (candidate.updatedAt !== current.updatedAt) {
    return candidate.updatedAt > current.updatedAt ? candidate : current;
  }
  return candidate.instanceId > current.instanceId ? candidate : current;
}

function insertIdentityInOrder(
  order: readonly string[],
  itemsByIdentity: Readonly<Record<string, AgentConversationInstance>>,
  identity: string,
): string[] {
  const nextOrder = order.filter((value) => value !== identity);
  const candidate = itemsByIdentity[identity];
  if (!candidate) return nextOrder;
  const insertAt = nextOrder.findIndex((value) => {
    const existing = itemsByIdentity[value];
    return existing ? compareConversationOrder(candidate, existing) < 0 : false;
  });
  nextOrder.splice(insertAt < 0 ? nextOrder.length : insertAt, 0, identity);
  return nextOrder;
}

/** Merge a page without re-sorting the already loaded rows on every render. */
export function mergeConversationPage(
  current: ConversationPageState,
  incoming: readonly AgentConversationInstance[],
): ConversationPageState {
  if (incoming.length === 0) return current;
  const itemsByIdentity = { ...current.itemsByIdentity };
  let orderedIdentities = [...current.orderedIdentities];
  for (const instance of incoming) {
    const identity = getConversationIdentity(instance);
    const previous = itemsByIdentity[identity];
    const selected = previous ? preferConversationInstance(previous, instance) : instance;
    itemsByIdentity[identity] = selected;
    orderedIdentities = insertIdentityInOrder(orderedIdentities, itemsByIdentity, identity);
  }
  return { itemsByIdentity, orderedIdentities };
}

/** Add live Zustand rows while keeping the same identity and sort contract. */
export function mergeLiveConversation(
  current: ConversationPageState,
  instance: AgentConversationInstance,
): ConversationPageState {
  return mergeConversationPage(current, [instance]);
}

export function updateConversationTitle(
  current: ConversationPageState,
  instanceId: string,
  title: string,
  updatedAt: number,
): ConversationPageState {
  const identity = current.orderedIdentities.find(
    (value) => current.itemsByIdentity[value]?.instanceId === instanceId,
  );
  if (!identity) return current;
  const existing = current.itemsByIdentity[identity];
  if (!existing) return current;
  return mergeLiveConversation(current, { ...existing, title, updatedAt });
}

export function removeConversation(
  current: ConversationPageState,
  instanceId: string,
): ConversationPageState {
  const identity = current.orderedIdentities.find(
    (value) => current.itemsByIdentity[value]?.instanceId === instanceId,
  );
  if (!identity) return current;
  const itemsByIdentity = { ...current.itemsByIdentity };
  delete itemsByIdentity[identity];
  return {
    itemsByIdentity,
    orderedIdentities: current.orderedIdentities.filter((value) => value !== identity),
  };
}
