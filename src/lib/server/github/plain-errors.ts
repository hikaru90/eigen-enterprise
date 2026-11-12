import type { GitHubTokenError } from './token-client'
import { KernelError } from '$lib/kernel/errors'
import { GitHubApiError } from './api'
import { isGitHubTokenError } from './token'

/**
 * code ↔ harness ↔ user: the owner (and the agent relaying to them) gets a
 * plain sentence, never GitHub's raw API error. The original error stays
 * attached as `cause` for logs and the audit trail.
 */
export class GitHubUserError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'GitHubUserError'
  }
}

function hhmmUtc(d: Date): string {
  return `${d.toISOString().slice(11, 16)} UTC`
}

/** Plain words for a GitHub API failure, by HTTP status (structured, not text-matched). */
export function plainGitHubApiMessage(err: GitHubApiError, what: string): string {
  if (err.rateLimited && err.rateLimitReset) {
    return `GitHub's limit for lookups is used up until ${hhmmUtc(err.rateLimitReset)}. Try again then, or connect GitHub so lookups use the app.`
  }
  if (err.status === 401)
    return 'GitHub refused the app’s credentials. Reconnect GitHub on this page.'
  if (err.status === 403)
    return `GitHub did not allow reading ${what}. Give the GitHub App access to it on GitHub.`
  if (err.status === 404) return `GitHub could not find ${what}.`
  if (err.status >= 500) return 'GitHub is not answering right now. Try again in a minute.'
  return `GitHub could not read ${what} right now. Try again in a minute.`
}

/** Shown when a pasted token turns out to be classic (it carries OAuth scopes). */
export const CLASSIC_TOKEN_REFUSED =
  'This is a classic token, which can change every repo you can. Create a fine-grained token with read-only access instead.'

/** Plain words for a fine-grained token client failure, by kind (structured, not text-matched). */
export function plainGitHubTokenMessage(err: GitHubTokenError, what: string): string {
  switch (err.kind) {
    case 'unauthorized':
      return 'GitHub no longer accepts this token. It may have expired or been revoked. Create a new fine-grained token and paste it here.'
    case 'no_access':
      return `The token can no longer see ${what}. Check the token’s repository access on GitHub.`
    case 'rate_limited':
      return err.resumeAt
        ? `GitHub’s rate limit is used up. Syncing pauses until ${hhmmUtc(err.resumeAt)}.`
        : 'GitHub’s rate limit is used up. Syncing pauses for a while.'
    case 'unavailable':
      return 'GitHub is not answering right now. Syncing tries again on its own.'
    case 'write_refused':
      return 'eigenEnterprise only reads from GitHub. This change was stopped before it reached GitHub.'
  }
}

/** Wraps any GitHub API failure into a GitHubUserError; everything else is rethrown untouched. */
export function asUserError(err: unknown, what: string): never {
  if (err instanceof GitHubApiError)
    throw new GitHubUserError(plainGitHubApiMessage(err, what), { cause: err })
  throw err
}

/** The message a UI shows for a failed GitHub action. */
export function plainMessage(err: unknown): string {
  if (err instanceof GitHubUserError) return err.message
  if (err instanceof GitHubApiError) return plainGitHubApiMessage(err, 'that')
  if (isGitHubTokenError(err)) return plainGitHubTokenMessage(err, 'that')
  if (err instanceof KernelError) {
    if (err.code === 'permission_denied') return 'Only an admin can do this.'
    if (err.code === 'invalid_input')
      return 'Some of what was entered is not valid. Check it and try again.'
    if (err.code === 'approval_required') return 'This is waiting for your approval in the chat.'
  }
  return 'Something went wrong while talking to GitHub. Try again; if it keeps happening, ask in the chat.'
}
