import { subscribe, type SubscribeOptions } from '@platform/tauri/event-bus';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { PluginRunEvent } from './desktop';

export function listenToPluginRuns(
  handler: (event: PluginRunEvent) => void,
  options?: SubscribeOptions,
): UnlistenFn {
  return subscribe<PluginRunEvent>('plugin-run', handler, options);
}

export function listenToPluginCatalogChanges(
  handler: () => void,
  options?: SubscribeOptions,
): UnlistenFn {
  return subscribe<unknown>('plugin-catalog-changed', handler, options);
}
