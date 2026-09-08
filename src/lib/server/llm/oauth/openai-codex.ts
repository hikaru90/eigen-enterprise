import { env } from '$lib/server/env/private-env'

/**
 * OpenAI Codex (ChatGPT Plus/Pro) subscription auth — device-code flow, ported from pi
 * (packages/ai/src/auth/oauth/openai-codex.ts, MIT).
 *
 * 1. POST {auth}/api/accounts/deviceauth/usercode → device_auth_id + user_code
 * 2. Poll {auth}/api/accounts/deviceauth/token → authorization_code + code_verifier
 * 3. POST {auth}/oauth/token (authorization_code, redirect /deviceauth/callback) → tokens
 * The access token is a JWT carrying the chatgpt_account_id claim needed for the
 * `chatgpt-account-id` request header.
 */

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'

function authBaseUrl(): string {
  return env.OAUTH_OPENAI_AUTH_BASE_URL?.trim() || 'https://auth.openai.com'
}

/** Codex chat base URL (the responses API path is appended per-request). */
export function codexBaseUrl(): string {
  return env.OAUTH_OPENAI_CODEX_BASE_URL?.trim() || 'https://chatgpt.com/backend-api'
}

export type CodexDeviceAuth = {
  deviceAuthId: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  expiresInSeconds: number
}

export async function startCodexDeviceAuth(): Promise<CodexDeviceAuth> {
  const res = await fetch(`${authBaseUrl()}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  })
  if (res.status === 404) {
    throw new Error('Codex device-code sign-in is not available on this OpenAI server.')
  }
  if (!res.ok) {
    throw new Error(`Codex device-code request failed (HTTP ${res.status}).`)
  }
  const data = (await res.json()) as Record<string, unknown>
  const deviceAuthId = typeof data.device_auth_id === 'string' ? data.device_auth_id : null
  const userCode = typeof data.user_code === 'string' ? data.user_code : null
  const rawInterval = data.interval
  const intervalSeconds =
    typeof rawInterval === 'number'
      ? rawInterval
      : typeof rawInterval === 'string'
        ? Number(rawInterval.trim())
        : Number.NaN
  if (!deviceAuthId || !userCode || !Number.isFinite(intervalSeconds)) {
    throw new Error('Codex device-code response was missing fields.')
  }
  return {
    deviceAuthId,
    userCode,
    verificationUri: `${authBaseUrl()}/codex/device`,
    intervalSeconds,
    expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS,
  }
}

export type CodexPollResult =
  | { status: 'pending' }
  | { status: 'connected'; authorizationCode: string; codeVerifier: string }
  | { status: 'failed'; error: string }

/** ONE poll attempt — the wizard calls this repeatedly on its own cadence. */
export async function pollCodexDeviceAuthOnce(
  device: { deviceAuthId: string; userCode: string },
): Promise<CodexPollResult> {
  const res = await fetch(`${authBaseUrl()}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    signal: AbortSignal.timeout(15_000),
  })
  if (res.ok) {
    const data = (await res.json()) as Record<string, unknown>
    const authorizationCode = typeof data.authorization_code === 'string' ? data.authorization_code : null
    const codeVerifier = typeof data.code_verifier === 'string' ? data.code_verifier : null
    if (!authorizationCode || !codeVerifier) {
      return { status: 'failed', error: 'Codex device auth returned an unexpected shape.' }
    }
    return { status: 'connected', authorizationCode, codeVerifier }
  }
  if (res.status === 403 || res.status === 404) {
    return { status: 'pending' }
  }
  const text = await res.text().catch(() => '')
  let errorCode: string | null = null
  try {
    const parsed = JSON.parse(text) as { error?: string | { code?: string } }
    errorCode = typeof parsed?.error === 'string' ? parsed.error : (parsed?.error?.code ?? null)
  } catch {
    // non-JSON error body
  }
  if (errorCode === 'deviceauth_authorization_pending') return { status: 'pending' }
  if (errorCode === 'slow_down') return { status: 'pending' }
  return {
    status: 'failed',
    error: `Codex device auth failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : '.'}`,
  }
}

export type CodexTokens = {
  access: string
  refresh: string
  expiresAtMs: number
  accountId: string
}

function extractAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split('.')
    if (parts.length !== 3) throw new Error('not a JWT')
    const payload = JSON.parse(atob(parts[1]!)) as Record<string, unknown>
    const claim = payload[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined
    const accountId = claim?.chatgpt_account_id
    if (typeof accountId !== 'string' || !accountId) throw new Error('no account id claim')
    return accountId
  } catch {
    throw new Error('Failed to extract the ChatGPT account id from the token.')
  }
}

async function readTokenResponse(res: Response): Promise<CodexTokens> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Codex token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }
  const data = (await res.json()) as {
    access_token?: unknown
    refresh_token?: unknown
    expires_in?: unknown
  }
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || typeof data.expires_in !== 'number') {
    throw new Error('Codex token response is missing fields.')
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAtMs: Date.now() + data.expires_in * 1000,
    accountId: extractAccountId(data.access_token),
  }
}

export async function exchangeCodexAuthorizationCode(input: {
  authorizationCode: string
  codeVerifier: string
}): Promise<CodexTokens> {
  const res = await fetch(`${authBaseUrl()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      redirect_uri: `${authBaseUrl()}/deviceauth/callback`,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  return readTokenResponse(res)
}

export async function refreshCodexToken(refreshToken: string): Promise<CodexTokens> {
  const res = await fetch(`${authBaseUrl()}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  return readTokenResponse(res)
}
