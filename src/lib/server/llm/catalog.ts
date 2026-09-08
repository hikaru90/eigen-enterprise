import { env } from '$lib/server/env/private-env'

export type CatalogModel = { id: string; name: string }

export type CatalogProvider = {
  /** Stable provider id — stored as llm_provider_config.provider. */
  id: string
  name: string
  baseUrl: string
  /** Provider-scoped env var hint from the catalog (e.g. GROQ_API_KEY). */
  envVar: string | null
  docUrl: string | null
  chatModels: CatalogModel[]
  embeddingModels: CatalogModel[]
}

type ModelsDevModel = {
  id?: unknown
  name?: unknown
  modalities?: { input?: unknown; output?: unknown }
}

type ModelsDevProvider = {
  id?: unknown
  name?: unknown
  npm?: unknown
  api?: unknown
  doc?: unknown
  env?: unknown
  models?: Record<string, ModelsDevModel>
}

const CATALOG_CACHE_MS = 24 * 60 * 60 * 1000
const CATALOG_FETCH_TIMEOUT_MS = 10_000

/**
 * EUrouter is a first-class provider regardless of catalog contents: its routing-rule
 * model selection does not come from a static model list.
 */
const EURouters: CatalogProvider = {
  id: 'eurouter',
  name: 'EUrouter',
  baseUrl: 'https://api.eurouter.ai/v1',
  envVar: 'SERVICE_API_KEY_EUROUTER',
  docUrl: null,
  chatModels: [],
  embeddingModels: [],
}

let cache: { fetchedAt: number; providers: CatalogProvider[] } | null = null

/** Test seam — module-level cache must be reset between specs. */
export function resetCatalogCache(): void {
  cache = null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Provider catalog for the onboarding wizard, from models.dev (the open model catalog
 * pi uses). Only providers our OpenAI-shaped gateway can actually speak to are offered
 * (`npm: @ai-sdk/openai-compatible`); EUrouter is pinned first-class. Fails loud —
 * the wizard surfaces the error with a retry instead of silently degrading.
 */
export async function getProviderCatalog(): Promise<{ source: 'models.dev'; providers: CatalogProvider[] }> {
  if (cache && Date.now() - cache.fetchedAt < CATALOG_CACHE_MS) {
    return { source: 'models.dev', providers: cache.providers }
  }

  const url = env.MODELS_DEV_CATALOG_URL?.trim() || 'https://models.dev/api.json'
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS) })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Provider catalog unreachable (${message}). Check your connection and retry.`, {
      cause: err,
    })
  }
  if (!res.ok) {
    throw new Error(`Provider catalog request failed (HTTP ${res.status}).`)
  }
  const body = (await res.json()) as unknown
  if (!isRecord(body)) {
    throw new Error('Provider catalog returned an unexpected shape.')
  }

  const providers: CatalogProvider[] = [EURouters]
  for (const [id, raw] of Object.entries(body)) {
    if (!isRecord(raw)) continue
    const entry = raw as ModelsDevProvider
    // Only API shapes our OpenAI-style gateway speaks: @ai-sdk/openai-compatible and
    // @ai-sdk/openai. Anthropic/Google/Bedrock-style shapes are never offered here.
    if (typeof entry.npm !== 'string' || !entry.npm.includes('openai')) continue
    if (id === 'eurouter') continue

    const chatModels: CatalogModel[] = []
    const embeddingModels: CatalogModel[] = []
    for (const model of Object.values(entry.models ?? {})) {
      const modelId = typeof model?.id === 'string' ? model.id : null
      if (!modelId) continue
      const name = typeof model?.name === 'string' ? model.name : modelId
      const output = asStringArray(model?.modalities?.output)
      if (output.includes('embedding')) embeddingModels.push({ id: modelId, name })
      else chatModels.push({ id: modelId, name })
    }

    providers.push({
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      baseUrl: typeof entry.api === 'string' && entry.api ? entry.api.replace(/\/$/, '') : '',
      envVar:
        Array.isArray(entry.env) && typeof entry.env[0] === 'string' ? entry.env[0] : null,
      docUrl: typeof entry.doc === 'string' && entry.doc ? entry.doc : null,
      chatModels: chatModels.sort((a, b) => a.name.localeCompare(b.name)),
      embeddingModels: embeddingModels.sort((a, b) => a.name.localeCompare(b.name)),
    })
  }

  providers.sort((a, b) => {
    if (a.id === 'eurouter') return -1
    if (b.id === 'eurouter') return 1
    return a.name.localeCompare(b.name)
  })

  cache = { fetchedAt: Date.now(), providers }
  return { source: 'models.dev', providers }
}
