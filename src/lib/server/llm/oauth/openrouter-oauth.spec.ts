import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createOpenRouterAuthorizeUrl, exchangeOpenRouterCode, generatePkce } from './openrouter-oauth'

describe('openrouter oauth (PKCE)', () => {
  it('builds an authorize URL carrying the callback and S256 challenge', () => {
    const { challenge } = generatePkce()
    const url = new URL(
      createOpenRouterAuthorizeUrl('https://app.example/api/onboarding/openrouter/callback', challenge),
    )
    expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
    expect(url.searchParams.get('callback_url')).toBe(
      'https://app.example/api/onboarding/openrouter/callback',
    )
    expect(url.searchParams.get('code_challenge')).toBe(challenge)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('generates a verifier whose S256 hash is the challenge', () => {
    const { verifier, challenge } = generatePkce()
    expect(verifier).not.toBe(challenge)
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
  })

  it('exchanges the authorization code for a permanent API key', async () => {
    const fetchMock = vi.fn(async () =>
      ({ ok: true, status: 200, json: async () => ({ key: 'sk-or-v1-permanent' }) }) as unknown as Response,
    )
    vi.stubGlobal('fetch', fetchMock)

    const { apiKey } = await exchangeOpenRouterCode('the-code', 'the-verifier')

    expect(apiKey).toBe('sk-or-v1-permanent')
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, string>
    expect(body).toEqual({ code: 'the-code', code_verifier: 'the-verifier', code_challenge_method: 'S256' })
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://openrouter.ai/api/v1/auth/keys')
  })

  it('surfaces exchange failures without swallowing the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        ({ ok: false, status: 400, json: async () => ({ error: 'bad code' }) }) as unknown as Response,
      ),
    )
    await expect(exchangeOpenRouterCode('nope', 'nope')).rejects.toThrow(/400.*bad code|bad code/)
  })
})
