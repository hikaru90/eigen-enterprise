import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { gitBlobSha, verifyGitBlobSha } from './git'

describe('git blob sha1', () => {
  it('computes sha1("blob " + byte size + NUL + bytes), including binary NULs', () => {
    const bytes = Uint8Array.from([0, 0xff, 0x80, 0x41, 0, 0x42])
    const expected = createHash('sha1')
      .update(`blob ${bytes.byteLength}\0`, 'utf8')
      .update(bytes)
      .digest('hex')

    expect(gitBlobSha(bytes)).toBe(expected)
    expect(gitBlobSha(new TextEncoder().encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('accepts a matching tree sha and fails loudly on a mismatch', () => {
    const bytes = new TextEncoder().encode('hello\n')
    const sha = gitBlobSha(bytes)
    expect(() => verifyGitBlobSha(bytes, sha)).not.toThrow()
    expect(() => verifyGitBlobSha(bytes, '0'.repeat(40))).toThrow(/mismatch.*ce013625030ba8dba906f756967f9e9ca394464a/i)
  })

  it('rejects a malformed expected sha instead of silently normalising it', () => {
    expect(() => verifyGitBlobSha(new Uint8Array(), 'ABC123')).toThrow(/40 lowercase hexadecimal/i)
  })
})
