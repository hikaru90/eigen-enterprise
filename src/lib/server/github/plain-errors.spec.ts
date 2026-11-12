import type { GitHubTokenError } from './token-client'
import { describe, expect, it } from 'vitest'
import { GitHubApiError } from './api'
import {
  CLASSIC_TOKEN_REFUSED,
  plainGitHubApiMessage,
  plainGitHubTokenMessage,
  plainMessage,
} from './plain-errors'
import { createGitHubTokenClient, tokenRequest } from './token'
import { fakeGitHub } from './token-fixtures'

async function tokenError(
  status: number,
  headers: Record<string, string> = {},
): Promise<GitHubTokenError> {
  const { impl } = fakeGitHub({
    'GET /repos/octo-org/repo-1': { status, body: { message: 'x' }, headers },
  })
  const gh = createGitHubTokenClient({ token: 'github_pat_x', fetch: impl, timeoutMs: 1000 })
  return (await gh.repo('octo-org/repo-1', null).catch((e: unknown) => e)) as GitHubTokenError
}

describe('plain words for token errors', () => {
  it('names what happened and what to do, per kind', async () => {
    expect(plainGitHubTokenMessage(await tokenError(401), 'octo-org/repo-1')).toBe(
      'GitHub no longer accepts this token. It may have expired or been revoked. Create a new fine-grained token and paste it here.',
    )
    expect(plainGitHubTokenMessage(await tokenError(404), 'octo-org/repo-1')).toBe(
      'The token can no longer see octo-org/repo-1. Check the token’s repository access on GitHub.',
    )
    expect(
      plainGitHubTokenMessage(
        await tokenError(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1762953900' }),
        'octo-org/repo-1',
      ),
    ).toBe('GitHub’s rate limit is used up. Syncing pauses until 13:25 UTC.')
    expect(plainGitHubTokenMessage(await tokenError(503), 'octo-org/repo-1')).toBe(
      'GitHub is not answering right now. Syncing tries again on its own.',
    )
    const refused = (await tokenRequest(
      { token: 't', fetch: fakeGitHub({}).impl, timeoutMs: 10 },
      'POST',
      '/x',
      null,
    ).catch((e: unknown) => e)) as GitHubTokenError
    expect(plainGitHubTokenMessage(refused, 'that')).toBe(
      'eigenEnterprise only reads from GitHub. This change was stopped before it reached GitHub.',
    )
  })

  it('plainMessage understands token errors too', async () => {
    expect(plainMessage(await tokenError(404))).toBe(
      'The token can no longer see that. Check the token’s repository access on GitHub.',
    )
  })

  it('the classic-token refusal is the plan’s sentence', () => {
    expect(CLASSIC_TOKEN_REFUSED).toBe(
      'This is a classic token, which can change every repo you can. Create a fine-grained token with read-only access instead.',
    )
  })

  it('the App wording stays for App callers', () => {
    expect(
      plainGitHubApiMessage(new GitHubApiError(401, '/x', 'Bad credentials', null), 'it'),
    ).toBe('GitHub refused the app’s credentials. Reconnect GitHub on this page.')
    expect(plainGitHubApiMessage(new GitHubApiError(403, '/x', 'nope', null), 'kindred/site')).toBe(
      'GitHub did not allow reading kindred/site. Give the GitHub App access to it on GitHub.',
    )
  })
})
