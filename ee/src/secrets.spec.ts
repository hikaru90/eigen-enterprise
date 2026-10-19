import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptSecrets, encryptSecrets, renderEnvFile } from './secrets.ts'

describe('secret store', () => {
  const key = randomBytes(32)

  it('round-trips', () => {
    const data = { os: { BETTER_AUTH_SECRET: 's3cr3t' } }
    expect(decryptSecrets(key, encryptSecrets(key, data))).toEqual(data)
  })

  it('fails loudly on the wrong key or tampering', () => {
    const blob = encryptSecrets(key, { os: { A: 'b' } })
    expect(() => decryptSecrets(randomBytes(32), blob)).toThrow(/failed to decrypt/)
    const parts = blob.split('.')
    parts[3] = Buffer.from('tampered').toString('base64')
    expect(() => decryptSecrets(key, parts.join('.'))).toThrow(/failed to decrypt/)
  })

  it('never emits plaintext in the blob', () => {
    expect(encryptSecrets(key, { os: { A: 'plaintext-value' } })).not.toContain('plaintext-value')
  })
})

describe('renderEnvFile', () => {
  it('quotes values safely', () => {
    expect(renderEnvFile({ B: 'say "hi"', A: "x y's" })).toBe('A="x y\'s"\nB="say \\"hi\\""\n')
  })

  it('rejects newlines', () => {
    expect(() => renderEnvFile({ A: 'a\nb' })).toThrow(/newline/)
  })
})
