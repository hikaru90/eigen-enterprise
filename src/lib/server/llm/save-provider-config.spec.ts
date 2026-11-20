import { beforeEach, describe, expect, it, vi } from 'vitest'
import { llmActiveProvider, llmProviderConfig, userPreference } from '$lib/server/db/schema'
import { companySwitch, saveProviderConfig } from './save-provider-config'

const { getDbMock, encryptTenantValueMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  encryptTenantValueMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/crypto/tenant-encryption', () => ({
  encryptTenantValue: encryptTenantValueMock,
}))

const useOwnKeyMock = vi.fn(async () => {})

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
    companySwitch.ownerId = async () => 'owner-1'
    companySwitch.useOwnKey = useOwnKeyMock
  })

  it('rejects an empty provider id (ids are free-form text, but never empty)', async () => {
    await expect(
      saveProviderConfig({
        userId: 'u1',
        provider: '  ' as never,
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

  it("the owner making a key active turns the company's \"Use eigenInference\" off (CB1)", async () => {
    const { insert } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })
    await saveProviderConfig({ userId: 'owner-1', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' })
    expect(useOwnKeyMock).toHaveBeenCalledWith('owner-1')
  })

  it('a key someone else saves changes nothing for the company', async () => {
    const { insert } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })
    await saveProviderConfig({ userId: 'member-1', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' })
    expect(useOwnKeyMock).not.toHaveBeenCalled()
  })

  it('the owner saving a key without making it active leaves the switch alone', async () => {
    const { insert } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })
    await saveProviderConfig({
      userId: 'owner-1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'k',
      setActive: false,
    })
    expect(useOwnKeyMock).not.toHaveBeenCalled()
  })

  it('a re-save that sends no model fields keeps the stored models (Settings sends none since CB1)', async () => {
    const { insert, calls } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })
    await saveProviderConfig({ userId: 'member-1', provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'k' })
    const conflictSet = callFor(calls, llmProviderConfig).conflictSet as Record<string, unknown>
    expect(conflictSet).not.toHaveProperty('modelChat')
    expect(conflictSet).not.toHaveProperty('modelEmbedding')
    expect(conflictSet).toMatchObject({ baseUrl: 'https://openrouter.ai/api/v1', apiKeyEncrypted: 'encrypted-blob' })
  })

  it('an explicit null still clears a field', async () => {
    const { insert, calls } = makeInsertRecorder()
    getDbMock.mockReturnValue({ insert })
    await saveProviderConfig({
      userId: 'member-1',
      provider: 'eurouter',
      baseUrl: 'https://api.eurouter.ai/v1',
      apiKey: 'k',
      ruleChat: null,
    })
    expect(callFor(calls, llmProviderConfig).conflictSet).toMatchObject({ ruleChat: null })
  })
})
