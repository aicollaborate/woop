import { create } from 'zustand';

interface DocumentMetricsState {
  documentKey: string | null;
  charCount: number;
  setCharCount: (documentKey: string, charCount: number) => void;
  clear: (documentKey?: string) => void;
}

/**
 * High-frequency, presentation-only document metrics.
 *
 * Keeping these outside MainLayout prevents every editor transaction from
 * rerendering the complete workspace chrome. This store is intentionally not
 * persisted: metrics are recomputed from the active document content.
 */
export const useDocumentMetricsStore = create<DocumentMetricsState>((set, get) => ({
  documentKey: null,
  charCount: 0,
  setCharCount: (documentKey, charCount) => {
    const current = get();
    if (current.documentKey === documentKey && current.charCount === charCount) return;
    set({ documentKey, charCount });
  },
  clear: (documentKey) => {
    const current = get();
    if (documentKey !== undefined && current.documentKey !== documentKey) return;
    if (current.documentKey === null && current.charCount === 0) return;
    set({ documentKey: null, charCount: 0 });
  },
}));
