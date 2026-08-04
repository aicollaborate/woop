import type { AgentTypeKey, RuntimeConfig, RuntimeConfigPatch } from "@/types/agent";
import { stripSystemBlock } from "@features/agent/message";
import { agentClient } from "@features/agent/store/agent-client";
import type {
  AgentConversationInstance,
  CreateAgentConversationInstanceInput,
} from "@features/agent/store/agent-conversation-types";
import type { ProjectionSlice } from "@features/agent/store/projection-slice";
import {
  EMPTY_AGENT_CONVERSATION_REGISTRY,
  type AgentConversationRegistry,
} from "@features/agent/store/session-state";
import type { AgentConversationInstance as BackendAgentConversationInstance } from "@platform/tauri/client";

type SessionSet = (
  updater: (state: ConversationContext) => Partial<ConversationContext> | ConversationContext,
) => void;
type ConversationContext = ConversationSlice &
  Pick<ProjectionSlice, "removeThreadProjection" | "applySessionResolved">;
type SessionGet = () => ConversationContext;
let instanceSequence = 0;
const instancePersistenceQueues = new Map<string, Promise<void>>();
const deletedInstanceIds = new Set<string>();

function markInstanceDeleted(instanceId: string): void {
  deletedInstanceIds.add(instanceId);
  while (deletedInstanceIds.size > 1_000) {
    const oldest = deletedInstanceIds.values().next().value as string | undefined;
    if (!oldest) break;
    deletedInstanceIds.delete(oldest);
  }
}

function createConversationInstanceId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `agent-inst-${randomUuid}`;
  instanceSequence += 1;
  return `agent-inst-${Date.now()}-${instanceSequence}-${Math.random().toString(36).slice(2)}`;
}

function nextUpdatedAt(existing?: AgentConversationInstance): number {
  return Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);
}

function enqueueInstancePersistence(
  instanceId: string,
  operation: () => Promise<unknown>,
  errorLabel: string,
): void {
  const previous = instancePersistenceQueues.get(instanceId);
  const run = () =>
    operation()
      .then(() => undefined)
      .catch((error) => {
        console.error(`[AgentSession] ${errorLabel}:`, error);
      });
  const pending = previous ? previous.then(run, run) : run();
  instancePersistenceQueues.set(instanceId, pending);
  void pending.finally(() => {
    if (instancePersistenceQueues.get(instanceId) === pending) {
      instancePersistenceQueues.delete(instanceId);
    }
  });
}

function normalizeTitle(title: string | null | undefined): string {
  return stripSystemBlock(title ?? "").replace(/\s+/g, " ").trim();
}

export function persistConversationInstance(instance: AgentConversationInstance): void {
  const { title, ...persisted } = instance;
  enqueueInstancePersistence(
    instance.instanceId,
    () => agentClient.upsertConversationInstance({
      ...persisted,
      initialTitle: title,
      runtimeConfig:
        instance.runtimeConfig && Object.keys(instance.runtimeConfig).length > 0
          ? JSON.stringify(instance.runtimeConfig)
          : null,
    }),
    "Failed to persist instance",
  );
}

function deletePersistedInstance(instanceId: string): void {
  enqueueInstancePersistence(
    instanceId,
    () => agentClient.deleteConversationInstance(instanceId),
    "Failed to delete instance",
  );
}

function deletePersistedInstancesForThread(threadId: string): void {
  void agentClient.deleteConversationInstancesForThread(threadId).catch((error) => {
    console.error("[AgentSession] Failed to delete thread instances:", error);
  });
}

function normalizeBackendInstance(
  instance: AgentConversationInstance | BackendAgentConversationInstance,
): AgentConversationInstance {
  const threadTitle = "threadTitle" in instance ? instance.threadTitle : null;
  let runtimeConfig: RuntimeConfig | null = null;
  if (instance.runtimeConfig) {
    if (typeof instance.runtimeConfig === "string") {
      try {
        runtimeConfig = JSON.parse(instance.runtimeConfig) as RuntimeConfig;
      } catch {
        runtimeConfig = null;
      }
    } else {
      runtimeConfig = instance.runtimeConfig;
    }
  }
  return {
    ...instance,
    title: threadTitle ?? "",
    runtimeConfig,
    role: instance.role ?? undefined,
  };
}

export interface ConversationSlice {
  conversationRegistry: AgentConversationRegistry;
  setConversationRegistry(
    updater: (registry: AgentConversationRegistry) => AgentConversationRegistry,
  ): void;
  hydrateFromBackend(): Promise<void>;
  createInstance(input: CreateAgentConversationInstanceInput): AgentConversationInstance;
  upsertInstance(
    instanceId: string,
    patch: Partial<Omit<AgentConversationInstance, "instanceId" | "createdAt">>,
  ): AgentConversationInstance;
  setRuntimeConfig(instanceId: string, patch: RuntimeConfigPatch): void;
  getInstance(instanceId: string | null | undefined): AgentConversationInstance | null;
  updateThread(
    instanceId: string,
    patch: { threadId?: string | null; agentType?: AgentTypeKey },
  ): void;
  renameInstance(instanceId: string, title: string): void;
  removeInstance(instanceId: string): void;
  removeInstancesForThread(threadId: string): void;
  resolveSessionByThreadId(
    localThreadId: string,
    sessionId: string,
    agentType: AgentTypeKey,
  ): string | null;
  findByThreadId(threadId: string): AgentConversationInstance | null;
}

export function createConversationSlice(
  set: SessionSet,
  get: SessionGet,
): ConversationSlice {
  return {
    conversationRegistry: EMPTY_AGENT_CONVERSATION_REGISTRY,
    setConversationRegistry: (updater) =>
      set((state) => ({
        conversationRegistry: updater(state.conversationRegistry),
      })),
    hydrateFromBackend: async () => {
      try {
        const instances = await agentClient.listConversationInstances();
        set((state) => {
          const next = { ...state.conversationRegistry.instances };
          for (const instance of instances) {
            const normalized = normalizeBackendInstance(instance);
            if (deletedInstanceIds.has(normalized.instanceId)) continue;
            const existing = next[normalized.instanceId];
            const hydrated =
              normalized.title === "" && existing?.threadId == null
                ? { ...normalized, title: existing.title }
                : normalized;
            if (!existing || normalized.updatedAt >= existing.updatedAt) {
              next[normalized.instanceId] = hydrated;
            }
          }
          return { conversationRegistry: { instances: next } };
        });
      } catch (error) {
        console.error("[AgentSession] Failed to hydrate instances:", error);
      }
    },
    createInstance: (input) => {
      const now = Date.now();
      const instance: AgentConversationInstance = {
        instanceId: createConversationInstanceId(),
        agentType: input.agentType,
        title: normalizeTitle(input.title),
        threadId: input.threadId ?? null,
        runtimeConfig: input.runtimeConfig ?? null,
        source: input.source,
        role: input.role,
        createdAt: now,
        updatedAt: now,
      };
      deletedInstanceIds.delete(instance.instanceId);
      get().setConversationRegistry((registry) => ({
        ...registry,
        instances: { ...registry.instances, [instance.instanceId]: instance },
      }));
      persistConversationInstance(instance);
      return instance;
    },
    upsertInstance: (instanceId, patch) => {
      const existing = get().conversationRegistry.instances[instanceId];
      const now = nextUpdatedAt(existing);
      const nextInstance: AgentConversationInstance = {
        instanceId,
        agentType: patch.agentType ?? existing?.agentType ?? "flowix",
        title:
          patch.title !== undefined
            ? normalizeTitle(patch.title)
            : existing?.title ?? "",
        threadId: patch.threadId ?? existing?.threadId ?? null,
        runtimeConfig:
          patch.runtimeConfig !== undefined
            ? patch.runtimeConfig
            : existing?.runtimeConfig ?? null,
        source: patch.source ?? existing?.source ?? { kind: "thread-card" },
        role: patch.role ?? existing?.role,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      deletedInstanceIds.delete(instanceId);
      get().setConversationRegistry((registry) => ({
        ...registry,
        instances: { ...registry.instances, [instanceId]: nextInstance },
      }));
      persistConversationInstance(nextInstance);
      return nextInstance;
    },
    setRuntimeConfig: (instanceId, patch) => {
      const existing = get().conversationRegistry.instances[instanceId];
      if (!existing) return;
      const runtimeConfig: RuntimeConfig = { ...(existing.runtimeConfig ?? {}) };
      for (const key of Object.keys(patch) as (keyof RuntimeConfigPatch)[]) {
        const value = patch[key];
        if (value !== undefined) {
          (runtimeConfig as Record<string, unknown>)[key] = value;
        }
      }
      const nextInstance = {
        ...existing,
        runtimeConfig,
        updatedAt: nextUpdatedAt(existing),
      };
      get().setConversationRegistry((registry) => ({
        ...registry,
        instances: { ...registry.instances, [instanceId]: nextInstance },
      }));
      persistConversationInstance(nextInstance);
    },
    getInstance: (instanceId) =>
      instanceId ? get().conversationRegistry.instances[instanceId] ?? null : null,
    updateThread: (instanceId, patch) => {
      const existing = get().conversationRegistry.instances[instanceId];
      if (!existing) return;
      const nextInstance: AgentConversationInstance = {
        ...existing,
        agentType: patch.agentType ?? existing.agentType,
        threadId:
          patch.threadId !== undefined ? patch.threadId : existing.threadId,
        updatedAt: nextUpdatedAt(existing),
      };
      get().setConversationRegistry((registry) => ({
        ...registry,
        instances: { ...registry.instances, [instanceId]: nextInstance },
      }));
      persistConversationInstance(nextInstance);
    },
    renameInstance: (instanceId, title) => {
      const nextTitle = normalizeTitle(title);
      const existing = get().conversationRegistry.instances[instanceId];
      if (!nextTitle || !existing || existing.title === nextTitle) return;
      const nextInstance = {
        ...existing,
        title: nextTitle,
        updatedAt: nextUpdatedAt(existing),
      };
      set((state) => ({
        conversationRegistry: {
          instances: {
            ...state.conversationRegistry.instances,
            [instanceId]: nextInstance,
          },
        },
      }));
      persistConversationInstance(nextInstance);
    },
    removeInstance: (instanceId) => {
      markInstanceDeleted(instanceId);
      set((state) => {
        if (!state.conversationRegistry.instances[instanceId]) return state;
        const { [instanceId]: _removed, ...instances } =
          state.conversationRegistry.instances;
        return { conversationRegistry: { instances } };
      });
      deletePersistedInstance(instanceId);
    },
    removeInstancesForThread: (threadId) => {
      const removedIds: string[] = [];
      set((state) => ({
        conversationRegistry: {
          instances: Object.fromEntries(
            Object.entries(state.conversationRegistry.instances).filter(
              ([instanceId, instance]) => {
                const remove = instance.threadId === threadId;
                if (remove) {
                  removedIds.push(instanceId);
                  markInstanceDeleted(instanceId);
                }
                return !remove;
              },
            ),
          ),
        },
      }));
      get().removeThreadProjection(threadId);
      for (const instanceId of removedIds) {
        deletePersistedInstance(instanceId);
      }
      deletePersistedInstancesForThread(threadId);
    },
    resolveSessionByThreadId: (localThreadId, sessionId, agentType) => {
      const instance = get().findByThreadId(localThreadId);
      get().applySessionResolved({
        kind: "session_resolved",
        agentType,
        threadId: localThreadId,
        sessionId,
        runId: `${localThreadId}-session-resolved`,
        timestamp: Date.now(),
      });
      return instance?.instanceId ?? null;
    },
    findByThreadId: (threadId) =>
      Object.values(get().conversationRegistry.instances).find(
        (instance) => instance.threadId === threadId,
      ) ?? null,
  };
}
