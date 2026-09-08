import { beforeEach, describe, expect, it, vi } from 'vitest'
import { llmActiveProvider, llmProviderConfig, userPreference } from '$lib/server/db/schema'
import { saveProviderConfig } from './save-provider-config'

const { getDbMock, encryptTenantValueMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  encryptTenantValueMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/crypto/tenant-encryption', () => ({
  encryptTenantValue: encryptTenantValueMock,
}))

type InsertCall = { table: unknown; values: unknown; conflictSet: unknown }

function makeInsertRecorder() {
  const calls: InsertCall[] = []
  const insert = vi.fn((table: unknown) => {
    const chain = {
      values: (values: unknown) => ({
        onConflictDoUpdate: (conflict: { set: unknown }) => {
          calls.push({ table, values, conflictSet: conflict.set })
          return Promise.resolve()
        },
      }),
    }
    return chain
  })
  return { insert, calls }
}

function callFor(calls: InsertCall[], table: unknown): InsertCall {
  const found = calls.find((c) => c.table === table)
  if (!found) throw new Error(`expected an insert into ${String(table)}`)
  return found
}

describe('saveProviderConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    encryptTenantValueMock.mockResolvedValue('encrypted-blob')
  })

  it('rejects an unknown provider', async () => {
    await expect(
      saveProviderConfig({
        userId: 'u1',
        provider: 'anthropic' as never,
        baseUrl: 'https://api.example.test/v1',
        apiKey: 'k',
      }),
    ).rejects.toThrow('Invalid provider.')
  })

  it('rejects a missing base URL', async () => {
    await expect(
      saveProviderConfig({ userId: 'u1', provider: 'openrouter', baseUrl: '', apiKey: 'k' }),
    ).rejects.toThrow('Base URL is required.')
  })

  it('rejects a base URL without a scheme', async () => {
    await expect(
      saveProviderConfig({
        userId: 'u1',
        provider: 'openrouter',
        baseUrl: 'openrouter.ai/api/v1',
        apiKey: 'k',
      }),
    ).rejects.toThrow('Base URL must start with http:// or https://')
  })

  it('rejects a missing API key', async () => {
    await expect(
      saveProviderConfig({
        userId: 'u1',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: '',
      }),
    ).rejects.toThrow('API key is required.')
  })

  it('encrypts the key, upserts config, sets active provider, and flips billing to byok', async () => {
    const { insert, calls } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })

    await saveProviderConfig({
      userId: 'u1',
      provider: 'eurouter',
      baseUrl: 'https://gw.example.test/v1/',
      apiKey: 'secret-key',
      ruleChat: 'rule-1',
      ruleEmbedding: 'rule-2',
    })

    expect(encryptTenantValueMock).toHaveBeenCalledWith({
      userId: 'u1',
      table: 'llm_provider_config',
      column: 'api_key',
      plaintext: 'secret-key',
    })

    const configRow = callFor(calls, llmProviderConfig).values as Record<string, unknown>
    expect(configRow).toMatchObject({
      userId: 'u1',
      provider: 'eurouter',
      baseUrl: 'https://gw.example.test/v1',
      apiKey: 'secret-key',
      apiKeyEncrypted: 'encrypted-blob',
      ruleChat: 'rule-1',
      ruleEmbedding: 'rule-2',
    })

    const activeRow = callFor(calls, llmActiveProvider).values as Record<string, unknown>
    expect(activeRow).toMatchObject({ userId: 'u1', provider: 'eurouter' })

    const prefRow = callFor(calls, userPreference).conflictSet as Record<string, unknown>
    expect(prefRow).toMatchObject({ billingMode: 'byok' })
  })

  it('stores null rules/models when omitted', async () => {
    const { insert, calls } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })

    await saveProviderConfig({
      userId: 'u1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      modelChat: 'openrouter/model',
    })

    const configRow = callFor(calls, llmProviderConfig).values as Record<string, unknown>
    expect(configRow.ruleChat).toBeNull()
    expect(configRow.ruleEmbedding).toBeNull()
    expect(configRow.modelChat).toBe('openrouter/model')
    expect(configRow.modelEmbedding).toBeNull()
  })

  it('skips the active-provider upsert when setActive is false but still flips billing', async () => {
    const { insert, calls } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })

    await saveProviderConfig({
      userId: 'u1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      setActive: false,
    })

    expect(() => callFor(calls, llmActiveProvider)).toThrow()
    expect(callFor(calls, userPreference).conflictSet).toMatchObject({ billingMode: 'byok' })
  })
})
