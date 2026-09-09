import { describe, expect, it } from 'vitest'
import { assertSafeSubpath, isSecretPath, resolveInsideWorktree } from './paths'

const WT = '/tmp/worktree'

describe('resolveInsideWorktree', () => {
  it('resolves relative subpaths inside the worktree', () => {
    expect(resolveInsideWorktree(WT, 'src/foo.ts')).toBe(`${WT}/src/foo.ts`)
    expect(resolveInsideWorktree(WT, 'src/lib/../foo.ts')).toBe(`${WT}/src/foo.ts`)
  })

  it('rejects empty subpaths', () => {
    expect(() => resolveInsideWorktree(WT, '')).toThrowError(/path is required/)
    expect(() => resolveInsideWorktree(WT, '   ')).toThrowError(/path is required/)
  })

  it('rejects .. escapes (simple, leading, embedded)', () => {
    expect(() => resolveInsideWorktree(WT, '../outside')).toThrowError(/path escapes the worktree/)
    expect(() => resolveInsideWorktree(WT, '..')).toThrowError(/escapes the worktree/)
    expect(() => resolveInsideWorktree(WT, 'src/../../outside')).toThrowError(/escapes the worktree/)
  })

  it('rejects absolute paths outside the worktree', () => {
    expect(() => resolveInsideWorktree(WT, '/etc/passwd')).toThrowError(/escapes the worktree/)
    expect(() => resolveInsideWorktree(WT, '/tmp/worktree/src/ok.ts')).not.toThrow()
  })

  it('rejects a bare worktree path (the whole worktree is not a file)', () => {
    expect(() => resolveInsideWorktree(WT, '.')).toThrowError(/path is required/)
  })
})

describe('isSecretPath', () => {
  it('blocks .env files at any depth', () => {
    expect(isSecretPath(`${WT}/.env`)).toBe(true)
    expect(isSecretPath(`${WT}/.env.local`)).toBe(true)
    expect(isSecretPath(`${WT}/config/.env.production`)).toBe(true)
    expect(isSecretPath(`${WT}/a/b/.env.staging`)).toBe(true)
  })

  it('blocks key and pem material by extension', () => {
    expect(isSecretPath(`${WT}/server.key`)).toBe(true)
    expect(isSecretPath(`${WT}/certs/tls.pem`)).toBe(true)
    expect(isSecretPath(`${WT}/id_rsa.key`)).toBe(true)
  })

  it('does not block ordinary source files', () => {
    expect(isSecretPath(`${WT}/src/env.ts`)).toBe(false)
    expect(isSecretPath(`${WT}/keys.ts`)).toBe(false)
    expect(isSecretPath(`${WT}/pemm.txt`)).toBe(false)
    expect(isSecretPath(`${WT}/src/envelope.ts`)).toBe(false)
  })
})

describe('assertSafeSubpath', () => {
  it('passes ordinary paths through', () => {
    expect(assertSafeSubpath(WT, 'src/new/module.ts', 'write')).toBe(`${WT}/src/new/module.ts`)
  })

  it('combines escape and secret checks for writes', () => {
    expect(() => assertSafeSubpath(WT, '.env', 'write')).toThrowError(/secret/)
    expect(() => assertSafeSubpath(WT, 'deploy/id.pem', 'write')).toThrowError(/secret/)
    expect(() => assertSafeSubpath(WT, '../.env', 'write')).toThrowError(/escapes/)
  })

  it('applies the secret check to reads too (exfiltration is a write-equivalent)', () => {
    expect(() => assertSafeSubpath(WT, '.env', 'read')).toThrowError(/secret/)
    expect(() => assertSafeSubpath(WT, '.env.local', 'read')).toThrowError(/secret/)
  })
})
