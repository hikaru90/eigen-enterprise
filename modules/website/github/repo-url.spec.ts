import { describe, expect, it } from 'vitest'
import { parseGitHubRepo } from './repo-url'

describe('parseGitHubRepo (structured URL parsing, not a meaning heuristic)', () => {
  it.each([
    ['https://github.com/kindred/site', { owner: 'kindred', repo: 'site', branch: null }],
    ['https://github.com/kindred/site/', { owner: 'kindred', repo: 'site', branch: null }],
    ['https://github.com/kindred/site.git', { owner: 'kindred', repo: 'site', branch: null }],
    ['https://www.github.com/Kindred/my.site', { owner: 'Kindred', repo: 'my.site', branch: null }],
    [
      'https://github.com/kindred/site/tree/main',
      { owner: 'kindred', repo: 'site', branch: 'main' },
    ],
    [
      'https://github.com/kindred/site/tree/feature/x',
      { owner: 'kindred', repo: 'site', branch: 'feature/x' },
    ],
    ['  kindred/site  ', { owner: 'kindred', repo: 'site', branch: null }],
    ['github.com/kindred/site', { owner: 'kindred', repo: 'site', branch: null }],
  ])('%s', (input, expected) => {
    expect(parseGitHubRepo(input)).toEqual({ ok: true, ...expected })
  })

  it.each([
    ['', 'Paste a GitHub link like https://github.com/owner/repo.'],
    ['https://gitlab.com/a/b', 'Only github.com repositories can be connected.'],
    ['http://github.com/a/b', 'Use the https:// link of the repository.'],
    [
      'https://github.com/kindred',
      'That link points to an account, not a repository. Use https://github.com/owner/repo.',
    ],
    [
      'https://github.com/kindred/site/issues/3',
      'That link points inside a repository. Use https://github.com/owner/repo.',
    ],
    ['https://github.com/kin dred/site', 'That is not a valid GitHub owner/repo name.'],
    ['https://github.com/a/b?x=1', 'Use the plain repository link, without ? or #.'],
  ])('rejects %s plainly', (input, message) => {
    expect(parseGitHubRepo(input)).toEqual({ ok: false, message })
  })
})
