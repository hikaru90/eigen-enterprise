import { describe, expect, it, vi } from 'vitest'
import { fetchInputFor } from './fetch-auth'

const base = {
  fullName: 'kindred/shop',
  branch: 'main',
  cloneUrl: 'https://github.com/kindred/shop.git',
}

describe('fetchInputFor: the right auth per kind', () => {
  it('public: https, no token, no key', async () => {
    const mint = vi.fn()
    const i = await fetchInputFor(
      { ...base, authKind: 'public', installationId: null, deployKeyId: null },
      'shop',
      mint,
    )
    expect(i).toEqual({ name: 'gh-shop', url: 'https://github.com/kindred/shop.git', ref: 'main' })
    expect(mint).not.toHaveBeenCalled()
  })
  it('deploy_key: ssh url and the key id ee holds; no token', async () => {
    const mint = vi.fn()
    const i = await fetchInputFor(
      {
        ...base,
        authKind: 'deploy_key',
        installationId: null,
        deployKeyId: 'dk_' + '0'.repeat(24),
      },
      'shop',
      mint,
    )
    expect(i).toEqual({
      name: 'gh-shop',
      url: 'git@github.com:kindred/shop.git',
      ref: 'main',
      deployKeyId: 'dk_' + '0'.repeat(24),
    })
    expect(mint).not.toHaveBeenCalled()
  })
  it('github_app: a token minted on demand for that installation', async () => {
    const mint = vi.fn(async (id: number) => `tok-${id}`)
    const i = await fetchInputFor(
      { ...base, authKind: 'github_app', installationId: 77, deployKeyId: null },
      'shop',
      mint,
    )
    expect(mint).toHaveBeenCalledWith(77)
    expect(i).toEqual({
      name: 'gh-shop',
      url: 'https://github.com/kindred/shop.git',
      ref: 'main',
      token: 'tok-77',
    })
  })
})
