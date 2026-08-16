import type { DeepSeekHarnessModelCatalog } from '@platform/tauri/client';

type ConfiguredModelRoute = {
  provider: string;
  apiUrl: string;
};

function normalizedEndpoint(value: string | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Resolve a model from a legacy/mixed Harness route to its installed catalog
 * route. A model id is not globally unique in llm-pi-ai (for example GLM is
 * present in both the international and China Z.AI routes), so the endpoint
 * is the authoritative discriminator. The first model-id match is only a
 * fallback for old settings that did not retain an endpoint.
 */
export function catalogProviderForConfiguredModel(
  config: ConfiguredModelRoute,
  modelId: string,
  catalog: DeepSeekHarnessModelCatalog | null | undefined,
): string | undefined {
  if (!catalog) return undefined;

  const matchingProviders = catalog.providers.filter((entry) =>
    entry.models.some((model) => model.id === modelId),
  );
  if (matchingProviders.length === 0) return undefined;

  const endpoint = normalizedEndpoint(config.apiUrl);
  if (endpoint) {
    const endpointMatch = matchingProviders.find((entry) =>
      normalizedEndpoint(entry.baseUrl) === endpoint,
    );
    if (endpointMatch) return endpointMatch.provider;
  }

  return matchingProviders[0]?.provider;
}
