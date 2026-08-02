import { describe, expect, it } from 'vitest';

import { cloudSyncErrorMessage } from '@platform/tauri/errors';

describe('cloudSyncErrorMessage', () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}:${JSON.stringify(params)}` : key;

  it('maps an inactive membership to an actionable message', () => {
    expect(cloudSyncErrorMessage('MEMBERSHIP_REQUIRED:null', t)).toBe(
      'preferences.cloud.membershipRequired',
    );
  });

  it('formats quota details for the upload prompt', () => {
    const message = cloudSyncErrorMessage(
      'STORAGE_QUOTA_EXCEEDED:{"usedBytes":52428800,"quotaBytes":52428800,"requestedDeltaBytes":1024}',
      t,
    );
    expect(message).toContain('preferences.cloud.quotaExceeded');
    expect(message).toContain('"used":"50.0 MB"');
    expect(message).toContain('"quota":"50.0 MB"');
    expect(message).toContain('"requested":"1.0 KB"');
  });
});
