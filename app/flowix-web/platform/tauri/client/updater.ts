import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

export interface AppUpdate {
  update: Update;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
}

export type AppUpdateDownloadProgress =
  | { phase: 'started'; contentLength?: number }
  | { phase: 'progress'; downloadedBytes: number; contentLength?: number }
  | { phase: 'finished'; downloadedBytes: number };

function isTauriDesktopRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/**
 * Check the signed Tauri updater manifest configured in the production bundle.
 * Dev/web/mobile surfaces deliberately return null instead of trying to call
 * the desktop updater plugin.
 */
export async function checkAppUpdate(): Promise<AppUpdate | null> {
  if (!isTauriDesktopRuntime()) return null;

  const update = await check({ timeout: 15_000 });
  if (!update) return null;

  return {
    update,
    currentVersion: update.currentVersion,
    version: update.version,
    date: update.date,
    body: update.body,
  };
}

export async function installAppUpdate(
  appUpdate: AppUpdate,
  onProgress?: (progress: AppUpdateDownloadProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let contentLength: number | undefined;

  await appUpdate.update.download((event: DownloadEvent) => {
    switch (event.event) {
      case 'Started':
        contentLength = event.data.contentLength;
        onProgress?.({ phase: 'started', contentLength });
        break;
      case 'Progress':
        downloadedBytes += event.data.chunkLength;
        onProgress?.({ phase: 'progress', downloadedBytes, contentLength });
        break;
      case 'Finished':
        onProgress?.({ phase: 'finished', downloadedBytes });
        break;
    }
  });

  await appUpdate.update.install();
  await relaunch();
}
