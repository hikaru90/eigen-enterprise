import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}))

vi.mock('$lib/server/env/private-env', () => ({ env: mockEnv }))

import {
  copilotChatBaseUrl,
  fetchCopilotAccessToken,
  pollCopilotDeviceFlowOnce,
  startCopilotDeviceFlow,
} from './github-copilot'

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response
}

const ACCESS_TOKEN_COOKIE =
  'tid=abc;exp=1893456000;proxy-ep=proxy.individual.githubcopilot.com;st=dot'

describe('github-copilot oauth', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.OAUTH_GITHUB_BASE_URL = ''
    mockEnv.OAUTH_GITHUB_API_BASE_URL = ''
  })
  afterEach(() => vi.restoreAllMocks())

  it('starts the device flow against github.com with the Copilot client id', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        device_code: 'dev-1',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const flow = await startCopilotDeviceFlow()

    expect(flow).toEqual({
      deviceCode: 'dev-1',
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
      intervalSeconds: 5,
      expiresInSeconds: 900,
    })
    const body = fetchMock.mock.calls[0]![1]!.body as URLSearchParams
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://github.com/login/device/code')
    expect(body.get('client_id')).toBe('Iv1.b507a08c87ecfe98')
    expect(body.get('scope')).toBe('read:user')
  })

  it('polls once and reports pending while the user has not authorized', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'authorization_pending' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(pollCopilotDeviceFlowOnce('dev-1')).resolves.toEqual({ status: 'pending' })
  })

  it('returns the GitHub token once the user authorizes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'gho_token', token_type: 'bearer' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(pollCopilotDeviceFlowOnce('dev-1')).resolves.toEqual({
      status: 'connected',
      githubToken: 'gho_token',
    })
  })

  it('exchanges the GitHub token for a short-lived Copilot token and derives the API base URL', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('copilot_internal')) {
        return jsonResponse({ token: ACCESS_TOKEN_COOKIE, expires_at: 1893456000 })
      }
      if (String(url).includes('/models')) {
        return jsonResponse({ data: [{ id: 'gpt-4.1' }, { id: 'claude-sonnet' }] })
      }
      throw new Error(`unexpected fetch ${String(url)}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const session = await fetchCopilotAccessToken('gho_token')

    expect(session.access).toBe(ACCESS_TOKEN_COOKIE)
    expect(session.refresh).toBe('gho_token')
    expect(session.baseUrl).toBe('https://api.individual.githubcopilot.com')
    expect(session.availableModelIds).toEqual(['gpt-4.1', 'claude-sonnet'])
    expect(session.expiresAtMs).toBe(1893456000 * 1000 - 5 * 60 * 1000)
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gho_token')
    expect(headers['Copilot-Integration-Id']).toBe('vscode-chat')
  })

  it('falls back to the default chat base URL when the token has no proxy-ep', () => {
    expect(copilotChatBaseUrl('tid=abc;exp=1')).toBe('https://api.individual.githubcopilot.com')
  })
})
