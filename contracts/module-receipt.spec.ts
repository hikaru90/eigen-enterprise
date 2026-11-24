import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  TEST_ONLY_MODULE_HUB_ORIGIN,
  TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8,
  TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI,
} from './fixtures/module-hub-test-key'
import {
  canonicalReceiptJson,
  keyId,
  receiptSigningPayload,
  RECEIPT_SIGNING_PREFIX,
  signReceipt,
  verifyReceipt,
  type ModuleReceiptFields,
  type ModuleReceiptV1,
} from './module-receipt'

const fields: ModuleReceiptFields = {
  hub: TEST_ONLY_MODULE_HUB_ORIGIN,
  installId: 'install-1',
  moduleId: 'hello',
  version: '0.1.0',
  commit: 'c0'.repeat(20),
  bundleSha256: 'ab'.repeat(32),
  manifestSha256: 'cd'.repeat(32),
  coreApi: '1.0.0',
  license: 'Apache-2.0',
  deprecatedUses: [],
  issuedAt: '2026-11-24T12:00:00.000Z',
}
const trusted = [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI]
const signed = () => signReceipt(fields, TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8)

describe('module receipts', () => {
  it('signs and verifies under the trusted hub key', () => {
    const r = signed()
    expect(r.v).toBe(1)
    expect(r.kind).toBe('eigen.module-receipt')
    expect(r.keyId).toBe(keyId(TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI))
    expect(r.keyId).toMatch(/^[0-9a-f]{16}$/)
    expect(verifyReceipt(r, trusted)).toEqual({ ok: true, receipt: r })
  })

  it('is deterministic (Ed25519) and survives a JSON round trip', () => {
    expect(signed()).toEqual(signed())
    expect(verifyReceipt(JSON.parse(JSON.stringify(signed())), trusted).ok).toBe(true)
  })

  it('signs the prefix plus canonical JSON of every field but the signature', () => {
    const r = signed()
    const { signature: _s, ...rest } = r
    const json = canonicalReceiptJson(rest)
    expect(json.startsWith('{"bundleSha256":')).toBe(true)
    expect(json).not.toContain('signature')
    expect(receiptSigningPayload(rest).toString('utf8')).toBe(RECEIPT_SIGNING_PREFIX + json)
  })

  const tampered: [keyof ModuleReceiptV1, unknown][] = [
    ['v', 2],
    ['kind', 'eigen.other'],
    ['hub', 'https://evil.test'],
    ['keyId', '0'.repeat(16)],
    ['installId', 'install-2'],
    ['moduleId', 'hellp'],
    ['version', '0.1.1'],
    ['commit', 'c1'.repeat(20)],
    ['bundleSha256', 'ac'.repeat(32)],
    ['manifestSha256', 'ce'.repeat(32)],
    ['coreApi', '1.0.1'],
    ['license', 'MIT'],
    ['deprecatedUses', ['contacts.get']],
    ['issuedAt', '2026-11-24T12:00:01.000Z'],
    ['signature', Buffer.alloc(64, 1).toString('base64')],
  ]
  it('covers every field', () => {
    expect(tampered.map(([k]) => k).sort()).toEqual(Object.keys(signed()).sort())
  })
  it.each(tampered)('refuses a receipt whose %s was changed', (key, value) => {
    const r = { ...signed(), [key]: value }
    const v = verifyReceipt(r, trusted)
    expect(v.ok).toBe(false)
  })

  it('refuses an extra field, a missing field and a non-object', () => {
    expect(verifyReceipt({ ...signed(), extra: 1 }, trusted).ok).toBe(false)
    const { issuedAt: _i, ...missing } = signed()
    expect(verifyReceipt(missing, trusted).ok).toBe(false)
    expect(verifyReceipt('receipt', trusted).ok).toBe(false)
  })

  it('refuses a receipt under an untrusted key, naming it', () => {
    const v = verifyReceipt(signed(), [])
    expect(v).toEqual({ ok: false, problem: expect.stringContaining('not a trusted hub key') })
    const other = generateKeyPairSync('ed25519')
    const forged = signReceipt(
      fields,
      other.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    )
    expect(verifyReceipt(forged, trusted).ok).toBe(false)
    const otherSpki = other.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect(verifyReceipt(forged, [otherSpki, ...trusted]).ok).toBe(true)
  })

  it('refuses a signature made by another key under the trusted key id', () => {
    const other = generateKeyPairSync('ed25519')
    const forged = signReceipt(
      fields,
      other.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    )
    const v = verifyReceipt(
      { ...forged, keyId: keyId(TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI) },
      trusted,
    )
    expect(v).toEqual({ ok: false, problem: expect.stringContaining('does not verify') })
  })

  it('refuses invalid fields at signing, and non-Ed25519 keys', () => {
    expect(() =>
      signReceipt({ ...fields, commit: 'short' }, TEST_ONLY_MODULE_HUB_PRIVATE_KEY_PKCS8),
    ).toThrow()
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
    expect(() =>
      signReceipt(
        fields,
        rsa.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      ),
    ).toThrow(/Ed25519/)
  })
})
