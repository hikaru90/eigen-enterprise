import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchMockInit, fetchMockUrl } from '$lib/test/vitest-mock-call'

/**
 * Acceptance case for CB1 (Ony, Contribute 19cf0d97, os.cerberusblue.com 2026-11-20):
 * a self-hosted box with no AI env at all; the company runs on the owner's own OpenRouter key
 * (billing mode byok on the owner, chat model saved, no embedding model). A member (admin
 * Ony, billing mode left at the default) captures a thought; the enrich worker's first gateway
 * call is the thought's embedding (`enrich-queued-thought.ts` → `createThoughtEmbedding`), made
 * under HER id. Before CB1 the gateway resolved her own settings → platform credits → the
 * platform EUrouter service account → "Platform EUrouter not configured: set LLM_BASE_URL".
 * It must run on the company's key with the install's embedding model instead.
 */

const OWNER = 'owner-olga'
const MEMBER = 'member-ony'

const { mockEnv, ownerRows, pinned, decryptMock } = vi.hoisted(() => ({
  // os.cerberusblue.com: no LLM_*, no SERVICE_API_KEY_*, no OPENROUTER_*, no PLATFORM_LLM_*.
  mockEnv: { EMBEDDING_COMPRESS_INTENSITY: 'lite', LLM_MIN_REQUEST_INTERVAL_MS: '0' } as Record<string, string>,
  ownerRows: {
    active: [{ userId: 'owner-olga', provider: 'openrouter' }],
    providers: [
      {
        userId: 'owner-olga',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
        apiKeyEncrypted: 'sealed',
        authType: 'api_key',
        ruleChat: null,
        ruleEmbedding: null,
        modelChat: '~deepseek/deepseek-flash-latest',
        modelEmbedding: null,
      },
    ],
  },
  pinned: { model: null as string | null },
  decryptMock: vi.fn(async () => 'sk-or-owner'),
}))

vi.mock('$lib/server/env/private-env', () => ({ env: mockEnv }))

/** Rows an account can read: the owner has the company's key; the member has nothing saved. */
function dbFor(userId: string) {
  let table: unknown
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.from = (t: unknown) => {
    table = t
    return chain
  }
  chain.where = () => chain
  const rows = async () => {
    const { llmActiveProvider, llmProviderConfig } = await import('$lib/server/db/schema')
    if (userId !== OWNER) return []
    if (table === llmActiveProvider) return ownerRows.active
    if (table === llmProviderConfig) return ownerRows.providers
    return []
  }
  chain.limit = () => rows()
  chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => rows().then(ok, bad)
  return chain
}

vi.mock('$lib/server/db', () => ({
  getDb: () => dbFor(MEMBER),
  withDbUser: async (userId: string, fn: (db: unknown) => Promise<unknown>) => fn(dbFor(userId)),
}))
vi.mock('$lib/server/db/billing-db-read', () => ({
  withBillingUserDbRead: async (userId: string, fn: (db: unknown) => Promise<unknown>) => fn(dbFor(userId)),
}))
vi.mock('$lib/server/llm/preferences', () => ({
  // the owner switched to their own key; the member never touched AI settings
  isByokBilling: vi.fn(async (userId: string) => userId === OWNER),
}))
vi.mock('$lib/server/llm/company-provider', () => ({
  companyOwnerId: async () => OWNER,
}))
vi.mock('$lib/server/llm/company-ai', () => ({
  // migration 0160 turns the switch off where the owner already ran on their own key
  companyAiStore: () => ({
    read: async () => ({
      useEigenInference: false,
      picks: { chat: null, stt: null, tts: null, decision: null },
      embeddingModel: pinned.model,
    }),
    pinEmbeddingModel: async (model: string) => {
      pinned.model ??= model
      return pinned.model
    },
  }),
}))
vi.mock('$lib/server/llm/member-daily-cap-store', () => ({
  // no daily AI cap per member set (DC3)
  memberDailyCapStore: { readCapUsd: async () => null },
}))
vi.mock('$lib/server/crypto/tenant-encryption', () => ({
  decryptTenantValue: decryptMock,
  encryptTenantValue: vi.fn(),
}))
vi.mock('$lib/server/activity/log-call', () => ({ logActivityCall: vi.fn() }))

import { createThoughtEmbedding } from './embedding'

function embeddingResponse(): Response {
  const vector = Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1 : 0))
  return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ embedding: vector }] }) } as unknown as Response
}

describe("a member's Memory ingest runs on the company's AI, not on the member's own settings", () => {
  beforeEach(() => {
    pinned.model = null
    decryptMock.mockClear()
  })

  it("embeds Ony's thought with the owner's OpenRouter key and the install's pinned embedding model", async () => {
    const fetchMock = vi.fn(async () => embeddingResponse())
    vi.stubGlobal('fetch', fetchMock)

    const vector = await createThoughtEmbedding(MEMBER, 'Call Acme about the renewal on Tuesday')

    expect(vector).toHaveLength(1536)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMockUrl(fetchMock)).toBe('https://openrouter.ai/api/v1/embeddings')
    const init = fetchMockInit(fetchMock)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-owner')
    const body = JSON.parse(String(init.body)) as { model: string }
    // the install had no embedding model anywhere: the pool's pick is pinned for good
    expect(body.model).toBe('qwen/qwen3-embedding-8b')
    expect(pinned.model).toBe('qwen/qwen3-embedding-8b')
    // the company's key is the owner's, decrypted on the owner's account
    expect(decryptMock).toHaveBeenCalledWith(expect.objectContaining({ userId: OWNER }))
  })
})
