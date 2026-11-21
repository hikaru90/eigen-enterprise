import { describe, expect, it, vi, beforeEach } from 'vitest'

// Re-sealing keys to visibility (shared-memory-keys.ts) is covered by memory-sharing.integration.spec.ts.
const { reconcileThoughtKeysMock, reconcileProjectKeysMock } = vi.hoisted(() => ({
  reconcileThoughtKeysMock: vi.fn(async () => 0),
  reconcileProjectKeysMock: vi.fn(async () => 0),
}))
vi.mock('$lib/server/memory/shared-memory-keys', () => ({
  reconcileThoughtKeys: reconcileThoughtKeysMock,
  reconcileProjectKeys: reconcileProjectKeysMock,
}))

const { encryptMock, decryptMock, dbMock } = vi.hoisted(() => ({
  encryptMock: vi.fn(async ({ plaintext }: { plaintext: string }) => `enc:${plaintext}`),
  decryptMock: vi.fn(async () => {
    throw new Error('Unsupported state or unable to authenticate data')
  }),
  dbMock: {
    select: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('$lib/server/crypto/tenant-encryption', () => ({
  encryptTenantValue: encryptMock,
  decryptTenantValue: decryptMock,
}))

vi.mock('$lib/server/db', () => ({
  getDb: () => dbMock,
}))

describe('repairThoughtEncryptionFromPlaintext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    const limit = vi.fn(async () => [
      {
        id: 't1',
        rawText: 'hello',
        rawTextEncrypted: '{"v":1}',
        normalizedText: 'hello',
        normalizedTextEncrypted: '{"v":1}',
        metadata: { encrypted: true },
        metadataEncrypted: '{"v":1}',
      },
    ])
    const where = vi.fn(() => ({ limit }))
    const from = vi.fn(() => ({ where }))
    dbMock.select.mockReturnValue({ from })
    const set = vi.fn(() => ({ where: vi.fn(async () => undefined) }))
    dbMock.update.mockReturnValue({ set })
  })

  it('re-encrypts from plaintext when decrypt auth fails', async () => {
    const { repairThoughtEncryptionFromPlaintext } =
      await import('$lib/server/crypto/repair-thought-encryption')
    const ok = await repairThoughtEncryptionFromPlaintext('user-1', 't1')
    expect(ok).toBe(true)
    expect(encryptMock).toHaveBeenCalled()
  })
})
