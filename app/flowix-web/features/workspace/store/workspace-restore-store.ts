import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { STORAGE_KEYS } from '@/lib/constants';

interface AgentConversationRestoreState {
  selectedInstanceId: string | null;
  detailOpen: boolean;
}

interface WorkspaceRestoreStore {
  version: 1;
  agentConversation: AgentConversationRestoreState;
  selectAgentConversation: (instanceId: string) => void;
  closeAgentConversationDetail: () => void;
  clearAgentConversation: (instanceId?: string) => void;
}

const EMPTY_AGENT_CONVERSATION_RESTORE: AgentConversationRestoreState = {
  selectedInstanceId: null,
  detailOpen: false,
};

export const useWorkspaceRestoreStore = create<WorkspaceRestoreStore>()(
  persist(
    (set) => ({
      version: 1,
      agentConversation: EMPTY_AGENT_CONVERSATION_RESTORE,
      selectAgentConversation: (instanceId) => {
        const normalized = instanceId.trim();
        if (!normalized) return;
        set({
          agentConversation: {
            selectedInstanceId: normalized,
            detailOpen: true,
          },
        });
      },
      closeAgentConversationDetail: () => set((state) => ({
        agentConversation: {
          ...state.agentConversation,
          detailOpen: false,
        },
      })),
      clearAgentConversation: (instanceId) => set((state) => {
        if (
          instanceId
          && state.agentConversation.selectedInstanceId !== instanceId
        ) {
          return state;
        }
        return { agentConversation: EMPTY_AGENT_CONVERSATION_RESTORE };
      }),
    }),
    {
      name: STORAGE_KEYS.WORKSPACE_RESTORE,
      partialize: (state) => ({
        version: state.version,
        agentConversation: state.agentConversation,
      }),
    },
  ),
);
