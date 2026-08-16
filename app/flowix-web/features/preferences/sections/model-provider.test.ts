import { describe, expect, it } from 'vitest';
import type { DeepSeekHarnessModelCatalog } from '@platform/tauri/client';
import { catalogProviderForConfiguredModel } from './model-provider';

const catalog: DeepSeekHarnessModelCatalog = {
  providers: [
    {
      provider: 'zai',
      displayName: 'Z.AI',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      takesApiKey: true,
      models: [{ id: 'glm-4.5-air' }],
    },
    {
      provider: 'zai-coding-cn',
      displayName: 'Z.AI Coding CN',
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      takesApiKey: true,
      models: [{ id: 'glm-4.5-air' }],
    },
  ],
};

describe('catalogProviderForConfiguredModel', () => {
  it('uses the saved endpoint when a model exists in multiple routes', () => {
    expect(catalogProviderForConfiguredModel(
      { provider: 'flowix', apiUrl: 'https://open.bigmodel.cn/api/coding/paas/v4/' },
      'glm-4.5-air',
      catalog,
    )).toBe('zai-coding-cn');
  });

  it('falls back to the first model match when old settings have no endpoint', () => {
    expect(catalogProviderForConfiguredModel(
      { provider: 'flowix', apiUrl: '' },
      'glm-4.5-air',
      catalog,
    )).toBe('zai');
  });
});
