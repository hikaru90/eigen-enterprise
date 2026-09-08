import { env } from '$lib/server/env/private-env'

/**
 * GitHub Copilot subscription auth (device flow), ported from pi
 * (packages/ai/src/auth/oauth/github-copilot.ts, MIT).
 *
 * 1. POST {github}/login/device/code          → user_code + verification_uri
 * 2. Poll {github}/login/oauth/access_token   → long-lived GitHub token
 * 3. GET {api.github}/copilot_internal/v2/token → short-lived Copilot access token
 * 4. Chat: POST {api base}/chat/completions (OpenAI-compatible + Copilot headers)
 */

const CLIENT_ID = 'Iv1.b507a08c87ecfe98' // public GitHub Copilot CLI client id (pi)
const COPILOT_API_VERSION = '2026-06-01'

export const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const

function githubBaseUrl(): string {
  return env.OAUTH_GITHUB_BASE_URL?.trim() || 'https://github.com'
}

function githubApiBaseUrl(): string {
  return env.OAUTH_GITHUB_API_BASE_URL?.trim() || 'https://api.github.com'
}

export type CopilotDeviceFlow = {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

export async function startCopilotDeviceFlow(): Promise<CopilotDeviceFlow> {
  const res = await fetch(`${githubBaseUrl()}/login/device/code`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': COPILOT_HEADERS['User-Agent'],
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'read:user' }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`GitHub device flow failed (HTTP ${res.status}).`)
  }
  const data = (await res.json()) as Record<string, unknown>
  const deviceCode = typeof data.device_code === 'string' ? data.device_code : null
  const userCode = typeof data.user_code === 'string' ? data.user_code : null
  const verificationUri = typeof data.verification_uri === 'string' ? data.verification_uri : null
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error('GitHub device flow returned an unexpected shape.')
  }
  let parsedUri: URL
  try {
    parsedUri = new URL(verificationUri)
  } catch {
    throw new Error('Untrusted verification_uri in GitHub device flow response.')
  }
  if (parsedUri.protocol !== 'https:' && parsedUri.protocol !== 'http:') {
    throw new Error('Untrusted verification_uri in GitHub device flow response.')
  }
  return {
    deviceCode,
    userCode,
    verificationUri: parsedUri.href,
    intervalSeconds: typeof data.interval === 'number' ? data.interval : 5,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : 900,
  }
}

export type CopilotPollResult =
  | { status: 'pending' }
  | { status: 'connected'; githubToken: string }
  | { status: 'failed'; error: string }

/** ONE poll attempt — the wizard calls this repeatedly on its own cadence. */
export async function pollCopilotDeviceFlowOnce(deviceCode: string): Promise<CopilotPollResult> {
  const res = await fetch(`${githubBaseUrl()}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': COPILOT_HEADERS['User-Agent'],
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    return { status: 'failed', error: `GitHub token poll failed (HTTP ${res.status}).` }
  }
  const data = (await res.json()) as Record<string, unknown>
  if (typeof data.access_token === 'string' && data.access_token) {
    return { status: 'connected', githubToken: data.access_token }
  }
  const error = typeof data.error === 'string' ? data.error : null
  if (error === 'authorization_pending') return { status: 'pending' }
  if (error === 'slow_down') return { status: 'pending' }
  if (error) {
    const description = typeof data.error_description === 'string' ? `: ${data.error_description}` : ''
    return { status: 'failed', error: `GitHub device flow failed: ${error}${description}` }
  }
  return { status: 'failed', error: 'GitHub token poll returned an unexpected shape.' }
}

export type CopilotSession = {
  /** Short-lived Copilot access token — the Bearer for chat calls. */
  access: string
  /** Long-lived GitHub token — re-exchanges for new access tokens. */
  refresh: string
  /** Epoch ms when the access token stops working (5 min safety margin applied). */
  expiresAtMs: number
  /** OpenAI-compatible chat base URL (derived from the token's proxy-ep). */
  baseUrl: string
  availableModelIds: string[]
}

/** Derives the chat base URL from the token's `proxy-ep` cookie (proxy.x → api.x). */
export function copilotChatBaseUrl(accessToken: string): string {
  const match = accessToken.match(/proxy-ep=([^;]+)/)
  if (match) {
    return `https://api.${match[1].replace(/^proxy\./, '')}`
  }
  return 'https://api.individual.githubcopilot.com'
}

/** Exchanges the long-lived GitHub token for a short-lived Copilot access token. */
export async function fetchCopilotAccessToken(githubToken: string): Promise<CopilotSession> {
  const res = await fetch(`${githubApiBaseUrl()}/copilot_internal/v2/token`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${githubToken}`,
      ...COPILOT_HEADERS,
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    throw new Error(`Copilot token exchange failed (HTTP ${res.status}). Is your subscription active?`)
  }
  const data = (await res.json()) as Record<string, unknown>
  const token = typeof data.token === 'string' ? data.token : null
  const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : null
  if (!token || expiresAt === null) {
    throw new Error('Copilot token response carried no usable token.')
  }
  const baseUrl = copilotChatBaseUrl(token)

  let availableModelIds: string[] = []
  try {
    const modelsRes = await fetch(`${baseUrl}/models`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...COPILOT_HEADERS,
        'X-GitHub-Api-Version': COPILOT_API_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (modelsRes.ok) {
      const body = (await modelsRes.json()) as { data?: Array<{ id?: unknown }> }
      availableModelIds = (body.data ?? [])
        .map((m) => (typeof m.id === 'string' ? m.id : null))
        .filter((id): id is string => id !== null)
    }
  } catch {
    // Model list is cosmetic; a missing list must not fail the connection.
  }

  return {
    access: token,
    refresh: githubToken,
    expiresAtMs: expiresAt * 1000 - 5 * 60 * 1000,
    baseUrl,
    availableModelIds,
  }
}
