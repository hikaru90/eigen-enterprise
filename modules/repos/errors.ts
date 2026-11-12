import type { GitHubTokenError, GitHubTokenErrorKind } from '$lib/server/github/token-client'

/** A problem the admin can fix, in plain words (shown on /m/repos and returned by tools). */
export class ReposError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ReposError'
  }
}

export const CLASSIC_TOKEN_MESSAGE =
  'This is a classic token, which can change every repo you can. Create a fine-grained token with read-only access instead.'

const KINDS: ReadonlySet<string> = new Set<GitHubTokenErrorKind>(['unauthorized', 'no_access', 'rate_limited', 'unavailable', 'write_refused'])

/** Structural check for the token client's errors (the contract is a type, not a class). */
export function isGitHubTokenError(err: unknown): err is GitHubTokenError {
  if (!(err instanceof Error)) return false
  const kind: unknown = (err as Error & { kind?: unknown }).kind
  return typeof kind === 'string' && KINDS.has(kind)
}

const dateLabel = (d: Date) => d.toISOString().slice(0, 10)

export const tokenMessages = {
  expired: (login: string, at: Date) => `The GitHub token for ${login} expired on ${dateLabel(at)}. Create a new one and paste it here.`,
  unauthorized: (login: string) => `The GitHub token for ${login} no longer works. Create a new one and paste it here.`,
  noAccess: (repo: string) => `The token can no longer see ${repo}.`,
  unavailable: 'GitHub did not answer. The next sync tries again.',
  failed: 'The sync failed. The next sync tries again.',
} as const
