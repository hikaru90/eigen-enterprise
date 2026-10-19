import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { pushTarget, verifyGitHubSignature } from './handler'

describe('verifyGitHubSignature', () => {
  const body = '{"zen":"Keep it logically awesome."}'
  const sig = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`

  it('accepts the right signature', () => {
    expect(verifyGitHubSignature('s3cret', body, sig)).toBe(true)
  })
  it('rejects a wrong secret, a tampered body, or no header', () => {
    expect(verifyGitHubSignature('other', body, sig)).toBe(false)
    expect(verifyGitHubSignature('s3cret', body + ' ', sig)).toBe(false)
    expect(verifyGitHubSignature('s3cret', body, null)).toBe(false)
    expect(verifyGitHubSignature('s3cret', body, 'sha1=abc')).toBe(false)
  })
})

describe('pushTarget', () => {
  const sha = 'a'.repeat(40)
  it('maps a branch push', () => {
    expect(pushTarget({ ref: 'refs/heads/main', after: sha, repository: { full_name: 'k/app' } })).toEqual({ repo: 'k/app', ref: 'main', after: sha })
  })
  it('ignores tags and deletions', () => {
    expect(pushTarget({ ref: 'refs/tags/v1', after: sha, repository: { full_name: 'k/app' } })).toBeNull()
    expect(pushTarget({ ref: 'refs/heads/main', after: '0'.repeat(40), deleted: true, repository: { full_name: 'k/app' } })).toBeNull()
  })
})
