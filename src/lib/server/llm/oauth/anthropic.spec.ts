import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}))

vi.mock('$lib/server/env/private-env', () => ({ env: mockEnv }))

import {
  createAnthropicAuthorizeUrl,
  exchangeAnthropicCode,
  parseAuthorizationInput,
  refreshAnthropicToken,
} from './anthropic'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

describe('anthropic oauth (Claude Pro/Max)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.OAUTH_ANTHROPIC_AUTHORIZE_URL = ''
    mockEnv.OAUTH_ANTHROPIC_TOKEN_URL = ''
  })
  afterEach(() => vi.restoreAllMocks())

  it('builds the authorize URL with code=true, S256 challenge and state=verifier', () => {
    const url = new URL(createAnthropicAuthorizeUrl('verifier-1'))
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize')
    expect(url.searchParams.get('code')).toBe('true')
    expect(url.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53692/callback')
    expect(url.searchParams.get('state')).toBe('verifier-1')
    expect(url.searchParams.get('scope')).toContain('user:inference')
  })

  it('parses pasted codes: bare code, code#state, query string, and full redirect URL', () => {
    expect(parseAuthorizationInput('abc')).toEqual({ code: 'abc' })
    expect(parseAuthorizationInput('abc#state-1')).toEqual({ code: 'abc', state: 'state-1' })
    expect(parseAuthorizationInput('code=abc&state=state-1')).toEqual({ code: 'abc', state: 'state-1' })
    expect(
      parseAuthorizationInput('http://localhost:53692/callback?code=abc&state=state-1'),
    ).toEqual({ code: 'abc', state: 'state-1' })
  })

  it('exchanges the authorization code for tokens', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'sk-ant-oat-1', refresh_token: 'refresh-1', expires_in: 3600 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tokens = await exchangeAnthropicCode({ code: 'abc', state: 'verifier-1', verifier: 'verifier-1' })

    expect(tokens.access).toBe('sk-ant-oat-1')
    expect(tokens.refresh).toBe('refresh-1')
    expect(tokens.expiresAtMs).toBeLessThan(Date.now() + 3600 * 1000)
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, string>
    expect(body.grant_type).toBe('authorization_code')
    expect(body.code_verifier).toBe('verifier-1')
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://platform.claude.com/v1/oauth/token')
  })

  it('rejects a state mismatch before exchanging', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      exchangeAnthropicCode({ code: 'abc', state: 'tampered', verifier: 'verifier-1' }),
    ).rejects.toThrow(/state mismatch/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refreshes tokens', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: 'sk-ant-oat-2', refresh_token: 'refresh-2', expires_in: 3600 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tokens = await refreshAnthropicToken('refresh-1')
    expect(tokens.access).toBe('sk-ant-oat-2')
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as Record<string, string>
    expect(body.grant_type).toBe('refresh_token')
    expect(body.refresh_token).toBe('refresh-1')
  })
})
