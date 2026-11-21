import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptEnvelope, encryptEnvelope, envelopeKeyId } from '$lib/server/crypto/envelope'

function keyFrom(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest()
}

describe('envelope encryption', () => {
  it('round-trips plaintext with matching AAD', () => {
    const key = keyFrom('test-key')
    const aad = 'tenant:u1|table:thought|column:raw_text'
    const encrypted = encryptEnvelope('hello world', key, aad)
    const decrypted = decryptEnvelope(encrypted, key, aad)
    expect(decrypted).toBe('hello world')
  })

  it('round-trips empty plaintext', () => {
    const key = keyFrom('test-key')
    const aad = 'tenant:u1|table:text_file|column:body_text'
    const encrypted = encryptEnvelope('', key, aad)
    const payload = JSON.parse(encrypted) as { data: string }
    expect(payload.data).toBe('')
    expect(decryptEnvelope(encrypted, key, aad)).toBe('')
  })

  it('rejects envelope missing required fields', () => {
    const key = keyFrom('test-key')
    expect(() => decryptEnvelope(JSON.stringify({ v: 1 }), key, 'aad')).toThrow(
      /Invalid encrypted envelope payload/,
    )
  })

  it('fails decrypt when AAD mismatches', () => {
    const key = keyFrom('test-key')
    const encrypted = encryptEnvelope('hello world', key, 'tenant:u1|table:thought|column:raw_text')
    expect(() =>
      decryptEnvelope(encrypted, key, 'tenant:u1|table:thought|column:normalized_text'),
    ).toThrow()
  })

  it('names the key it was sealed with only when asked to (the company key)', () => {
    const key = keyFrom('test-key')
    const personal = encryptEnvelope('a', key, 'aad')
    const company = encryptEnvelope('b', key, 'aad', 'company')
    expect(envelopeKeyId(personal)).toBeNull()
    expect(envelopeKeyId(company)).toBe('company')
    expect(decryptEnvelope(company, key, 'aad')).toBe('b')
  })

  it('refuses a key id it does not know', () => {
    const key = keyFrom('test-key')
    const forged = JSON.stringify({ ...JSON.parse(encryptEnvelope('x', key, 'aad')), k: 'someone' })
    expect(() => envelopeKeyId(forged)).toThrow(/unknown envelope key id/i)
  })
})
