import { createHash } from 'node:crypto'
import { env } from '$lib/server/env/private-env'

/**
 * Anthropic OAuth (Claude Pro/Max) — manual-code web flow, ported from pi
 * (packages/ai/src/auth/oauth/anthropic.ts, MIT).
 *
 * The redirect target is pi's loopback (localhost:53692) — in a browser it shows an
 * error page, so the user copies the code / full redirect URL back into the wizard
 * (pi's "manual_code" pattern). `state` equals the PKCE verifier, so a pasted full URL
 * lets us validate state server-side.
 */

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

function authorizeUrl(): string {
  return env.OAUTH_ANTHROPIC_AUTHORIZE_URL?.trim() || 'https://claude.ai/oauth/authorize'
}

function tokenUrl(): string {
  return env.OAUTH_ANTHROPIC_TOKEN_URL?.trim() || 'https://platform.claude.com/v1/oauth/token'
}

/** Chat base URL for saved Anthropic credentials (env-overridable for e2e). */
export function anthropicApiBaseUrl(): string {
  return env.OAUTH_ANTHROPIC_API_BASE_URL?.trim() || 'https://api.anthropic.com'
}

/** Claude Code identity headers required for OAuth-token requests (pi: createClient). */
export const ANTHROPIC_OAUTH_HEADERS = {
  'user-agent': 'claude-cli/2.1.251',
  'x-app': 'cli',
} as const

/** Betas required for OAuth-token requests (pi: getBetaFeatures, isOAuthToken branch). */
export const ANTHROPIC_OAUTH_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'] as const

/** Required first system block for OAuth-token requests (pi: buildParams). */
export const ANTHROPIC_OAUTH_SYSTEM_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

export function createAnthropicAuthorizeUrl(verifier: string): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: 'http://localhost:53692/callback',
    scope: SCOPES,
    code_challenge: createChallenge(verifier),
    code_challenge_method: 'S256',
    state: verifier,
  })
  return `${authorizeUrl()}?${params.toString()}`
}

function createChallenge(verifier: string): string {
  // pi uses the verifier as state and a SHA-256 S256 challenge of it (generatePKCE shape).
  return createHash('sha256').update(verifier).digest('base64url')
}

export type ParsedAuthorization = { code?: string; state?: string }

/** Accepts a bare code, `code#state`, a query string, or the full redirect URL. */
export function parseAuthorizationInput(input: string): ParsedAuthorization {
  const value = input.trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    }
  } catch {
    // not a URL
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code, state }
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined }
  }
  return { code: value }
}

export type AnthropicTokens = {
  access: string
  refresh: string
  /** Epoch ms when the access token expires (5 min safety margin). */
  expiresAtMs: number
}

async function postToken(body: Record<string, string>): Promise<AnthropicTokens> {
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Anthropic token request failed (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }
  let data: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
  try {
    data = JSON.parse(text) as typeof data
  } catch {
    throw new Error('Anthropic token response was not JSON.')
  }
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || typeof data.expires_in !== 'number') {
    throw new Error('Anthropic token response is missing fields.')
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expiresAtMs: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
  }
}

export async function exchangeAnthropicCode(input: {
  code: string
  state: string
  verifier: string
}): Promise<AnthropicTokens> {
  if (input.state !== input.verifier) {
    throw new Error('OAuth state mismatch — restart the sign-in.')
  }
  return postToken({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code: input.code,
    state: input.state,
    redirect_uri: 'http://localhost:53692/callback',
    code_verifier: input.verifier,
  })
}

export async function refreshAnthropicToken(refreshToken: string): Promise<AnthropicTokens> {
  return postToken({
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  })
}
