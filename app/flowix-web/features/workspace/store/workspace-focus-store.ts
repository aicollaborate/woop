import { create } from 'zustand';

export type WorkspaceHostId = 'main-third' | 'browser-column';

interface WorkspaceFocusState {
  focusedHostId: WorkspaceHostId;
  focusHost: (hostId: WorkspaceHostId) => void;
  reset: () => void;
}

export const useWorkspaceFocusStore = create<WorkspaceFocusState>((set) => ({
  focusedHostId: 'main-third',
  focusHost: (focusedHostId) => set({ focusedHostId }),
  reset: () => set({ focusedHostId: 'main-third' }),
}));
