import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribe } from '@platform/tauri/event-bus';
import {
  dshIntegration,
  type DshDownloadProgress,
  type DshIntegrationStatus,
} from '@platform/tauri/client';

const DSH_DOWNLOAD_PROGRESS_EVENT = 'dsh-download-progress';

function isActiveDownload(progress: DshDownloadProgress | null): boolean {
  return progress?.phase === 'checking'
    || progress?.phase === 'downloading'
    || progress?.phase === 'downloaded';
}

/** Shared installation state for the DSH setup and Runtime settings views. */
export function useDshRuntimeInstaller(initialStatus?: DshIntegrationStatus | null) {
  const [status, setStatus] = useState<DshIntegrationStatus | null>(initialStatus ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<DshDownloadProgress | null>(null);
  const cancelRequestedRef = useRef(false);

  const handleProgress = useCallback((next: DshDownloadProgress) => {
    setProgress(isActiveDownload(next) ? next : null);
    setBusy(isActiveDownload(next));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await dshIntegration.status();
      setStatus(next);
      setError(null);
      return next;
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      setError(message);
      throw value;
    }
  }, []);

  useEffect(() => {
    const unsubscribe = subscribe<DshDownloadProgress>(DSH_DOWNLOAD_PROGRESS_EVENT, handleProgress);
    void refresh().catch(() => {
      // The hook exposes the error to the view; no unhandled promise is needed.
    });
    void dshIntegration.downloadStatus()
      .then((next) => {
        if (next) handleProgress(next);
      })
      .catch(() => {
        // The active download remains observable through native events.
      });
    return unsubscribe;
  }, [handleProgress, refresh]);

  const install = useCallback(async () => {
    cancelRequestedRef.current = false;
    setBusy(true);
    setError(null);
    setProgress({
      phase: 'checking',
      downloadedBytes: 0,
      totalBytes: null,
      percent: null,
      resumed: false,
    });
    try {
      const next = await dshIntegration.ensureRuntime();
      setStatus(next);
      return next;
    } catch (value) {
      const message = value instanceof Error ? value.message : String(value);
      setError(cancelRequestedRef.current ? null : message);
      return null;
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, []);

  const cancel = useCallback(async () => {
    cancelRequestedRef.current = true;
    try {
      await dshIntegration.cancelUpdate();
      return true;
    } catch (value) {
      cancelRequestedRef.current = false;
      setError(value instanceof Error ? value.message : String(value));
      return false;
    }
  }, []);

  /** Remove the managed runtime tree. Returns the post-uninstall status
   * (installed: false), or null when the backend rejected the uninstall. */
  const uninstall = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await dshIntegration.uninstallRuntime();
      setStatus(next);
      return next;
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, progress, refresh, install, cancel, uninstall };
}
