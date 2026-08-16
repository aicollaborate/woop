/**
 * Static model directory over the vendored `llm-pi-ai` catalog. The catalog is
 * compiled into the host bundle, so `catalog()` answers without a runtime
 * child, without credentials, and without a network call; `discover()` is the
 * stateless one-shot endpoint interrogation for drafts that name a custom
 * gateway. Neither path writes anything — `agent-config.toml` on the Flowix
 * side stays the only source of truth.
 */

import { catalogModels, catalogProvider, catalogProviderIds, catalogProviderTakesApiKey } from '../../vendor/deepseek-harness/packages/llm/llm-pi-ai/lib/types/catalog.js'
import { discoverModels } from '../../vendor/deepseek-harness/packages/llm/llm-pi-ai/lib/types/discovery.js'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm/types'

/** One catalog model with the capacities a selector shows. */
export interface CatalogModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

/** One catalog provider route with its advisory model list. */
export interface CatalogProvider {
  provider: string
  displayName?: string
  /** Default endpoint from the installed pi-ai provider, when available. */
  baseUrl?: string
  /** Shared wire protocol for this provider's catalog models, when unambiguous. */
  api?: string
  /** Whether this route authenticates with an API key. */
  takesApiKey: boolean
  models: CatalogModel[]
}

/**
 * List every installed catalog route with its models. Advisory only: an
 * unlisted model id remains requestable.
 * @returns catalog routes in registry order.
 */
export function catalog(): CatalogProvider[] {
  return catalogProviderIds().map(provider => {
    const catalogProviderDefinition = catalogProvider(provider)
    const sourceModels = [...catalogModels(provider).values()]
    const apis = [...new Set(sourceModels.map(model => model.api))]
    const baseUrl = catalogProviderDefinition?.baseUrl ?? sourceModels[0]?.baseUrl
    const models = sourceModels.map(model => ({
      id: model.id,
      ...(model.name === undefined ? {} : { name: model.name }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    }))
    return {
      provider,
      ...(catalogProviderDefinition?.name === undefined ? {} : { displayName: catalogProviderDefinition.name }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(apis.length === 1 ? { api: apis[0] } : {}),
      takesApiKey: catalogProviderTakesApiKey(provider),
      models,
    }
  })
}

/**
 * Interrogate one draft endpoint for the models it advertises. The request
 * carries what the user is still editing — including a one-shot probe key the
 * host never stores — and the reply is candidate metadata for adoption.
 * @param request - the endpoint, protocol, and optional credential to use.
 * @returns the advertised models in endpoint order.
 */
export function discover(request: LlmModelDiscoveryRequest): Promise<readonly LlmDiscoveredModel[]> {
  return discoverModels(request)
}

/** Resolve one exact catalog entry for the host's metadata endpoint. */
export function resolveCatalogModel(provider: string, modelId: string): CatalogModel | undefined {
  const model = catalogModels(provider).get(modelId)
  if (model === undefined) return undefined
  return {
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
  }
}
