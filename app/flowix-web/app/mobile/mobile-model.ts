import type { CloudState } from '@platform/tauri/mobile-client';

export interface MobileTag {
  id: string;
  name: string;
}

export function cloudSyncAvailable(state: CloudState | null): boolean {
  return Boolean(
    state?.authenticated
    && state.enabled
    && state.membership?.active
    && !state.membership.readOnly,
  );
}
