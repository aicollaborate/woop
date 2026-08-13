import { plugins, type PluginArtifact } from '@platform/tauri/client';
import { listenToPluginRuns } from '@platform/tauri/client/plugin';

const activeRuns = new Map<string, Promise<PluginArtifact>>();

export interface PluginRunRequest {
  pluginId: string;
  userPrompt: string;
  context: string;
  agentType: string;
  notebookPath: string;
  sourceNote?: string;
}

export function runPlugin(request: PluginRunRequest): Promise<PluginArtifact> {
  const existing = activeRuns.get(request.pluginId);
  if (existing) return existing;

  const promise = (async () => {
    return await new Promise<PluginArtifact>((resolve, reject) => {
      let unlisten: (() => void) | undefined;
      let runId: string | undefined;
      let settled = false;
      let resolveListenerReady: (() => void) | undefined;
      const listenerReady = new Promise<void>((resolveReady) => {
        resolveListenerReady = resolveReady;
      });
      const timeout = window.setTimeout(() => {
        settled = true;
        unlisten?.();
        if (runId) void plugins.runStop(runId);
        reject(new Error('Plugin generation timed out'));
      }, 10 * 60 * 1000);
      unlisten = listenToPluginRuns((event) => {
        if (event.pluginId !== request.pluginId) return;
        if (!runId && event.status === 'started') {
          runId = event.runId;
          return;
        }
        if (!runId || event.runId !== runId) return;
        if (event.status === 'failed') {
          settled = true;
          window.clearTimeout(timeout);
          unlisten?.();
          reject(new Error(event.error || 'Plugin generation failed'));
        } else if (event.status === 'cancelled') {
          settled = true;
          window.clearTimeout(timeout);
          unlisten?.();
          reject(new Error('Plugin generation cancelled'));
        } else if (event.status === 'completed' && event.artifact) {
          settled = true;
          window.clearTimeout(timeout);
          unlisten?.();
          resolve(event.artifact);
        }
      }, {
        onListenerReady: () => resolveListenerReady?.(),
      });
      void listenerReady.then(() => {
        if (settled) return;
        return plugins.run(request).then((started) => {
          if (settled) {
            void plugins.runStop(started.runId);
            return;
          }
          runId = started.runId;
        });
      }).catch((error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        unlisten?.();
        reject(error);
      });
    });
  })();
  activeRuns.set(request.pluginId, promise);
  void promise.finally(() => {
    if (activeRuns.get(request.pluginId) === promise) activeRuns.delete(request.pluginId);
  }).catch(() => undefined);
  return promise;
}

export function isPluginRunning(pluginId: string): boolean {
  return activeRuns.has(pluginId);
}
