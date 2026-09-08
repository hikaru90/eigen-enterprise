import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}))

vi.mock('$lib/server/env/private-env', () => ({ env: mockEnv }))

import {
  exchangeCodexAuthorizationCode,
  pollCodexDeviceAuthOnce,
  refreshCodexToken,
  startCodexDeviceAuth,
} from './openai-codex'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
}

const JWT_PAYLOAD = { 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' } }
const JWT = ['e30', btoa(JSON.stringify(JWT_PAYLOAD)).replace(/=/g, ''), 'sig'].join('.')

describe('openai codex oauth (ChatGPT Plus/Pro)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.OAUTH_OPENAI_AUTH_BASE_URL = ''
  })
  afterEach(() => vi.restoreAllMocks())

  it('starts the device auth and points at the verification page', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ device_auth_id: 'da-1', user_code: 'TEST-CODE', interval: 2 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const device = await startCodexDeviceAuth()

    expect(device).toMatchObject({
      deviceAuthId: 'da-1',
      userCode: 'TEST-CODE',
      verificationUri: 'https://auth.openai.com/codex/device',
      intervalSeconds: 2,
    })
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://auth.openai.com/api/accounts/deviceauth/usercode',
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as { client_id: string }
    expect(body.client_id).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
  })

  it('reports pending on 403 and connects when the authorization code arrives', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'deviceauth_authorization_pending' }, 403))
      .mockResolvedValueOnce(jsonResponse({ authorization_code: 'ac-1', code_verifier: 'cv-1' }))
    vi.stubGlobal('fetch', fetchMock)

    const device = { deviceAuthId: 'da-1', userCode: 'TEST-CODE' }
    await expect(pollCodexDeviceAuthOnce(device)).resolves.toEqual({ status: 'pending' })
    await expect(pollCodexDeviceAuthOnce(device)).resolves.toEqual({
      status: 'connected',
      authorizationCode: 'ac-1',
      codeVerifier: 'cv-1',
    })
  })

  it('exchanges the authorization code for tokens with the account id extracted', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: JWT,
        refresh_token: 'r-1',
        expires_in: 3600,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tokens = await exchangeCodexAuthorizationCode({ authorizationCode: 'ac-1', codeVerifier: 'cv-1' })

    expect(tokens.accountId).toBe('acct-1')
    expect(tokens.access).toBe(JWT)
    const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe('https://auth.openai.com/deviceauth/callback')
  })

  it('refreshes tokens', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: JWT, refresh_token: 'r-2', expires_in: 3600 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const tokens = await refreshCodexToken('r-1')
    expect(tokens.refresh).toBe('r-2')
    const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams
    expect(body.get('grant_type')).toBe('refresh_token')
  })
})
