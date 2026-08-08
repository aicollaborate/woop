import { invoke } from '@tauri-apps/api/core';

import type { CloudState, CloudSyncResult } from './cloud';

export const mobile = {
  initialize: () => invoke<CloudState>('mobile_initialize'),
  bootstrapCloud: () => invoke<CloudSyncResult>('mobile_bootstrap_cloud'),
  resetCloudBinding: () => invoke<void>('mobile_reset_cloud_binding'),
};
