import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useDocumentMetricsStore } from '@features/document/store/document-metrics-store';

describe('document metrics store', () => {
  beforeEach(() => {
    useDocumentMetricsStore.setState({ documentKey: null, charCount: 0 });
  });

  it('does not notify for an unchanged metric', () => {
    const subscriber = vi.fn();
    useDocumentMetricsStore.getState().setCharCount('memo:a', 12);
    const unsubscribe = useDocumentMetricsStore.subscribe(subscriber);

    useDocumentMetricsStore.getState().setCharCount('memo:a', 12);

    expect(subscriber).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('does not let an old document cleanup clear the active metric', () => {
    useDocumentMetricsStore.getState().setCharCount('memo:new', 20);
    useDocumentMetricsStore.getState().clear('memo:old');

    expect(useDocumentMetricsStore.getState()).toMatchObject({
      documentKey: 'memo:new',
      charCount: 20,
    });
  });
});
