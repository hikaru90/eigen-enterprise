import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import GitHubPage from './+page.svelte'

vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
// Forms post for real in the app; here only what the page does before posting is under test.
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => {} }) }))

const at = '2026-11-20T12:00:00.000Z'

function data(copyMode: 'all' | 'docs' = 'all') {
  return {
    active: true,
    summaryNoModel: false,
    tokens: [
      {
        id: 't1',
        login: 'ada',
        last4: '9z9z',
        expiresAt: null,
        expiresSoon: false,
        expired: false,
        lastError: null,
        createdAt: at,
        repos: [
          {
            id: 's1',
            repoId: 4242,
            fullName: 'kindred/shop',
            defaultBranch: 'main',
            copyMode,
            lastSyncedAt: at,
            nextDueAt: at,
            lastError: null,
            pausedUntil: null,
            summary: { writtenAt: null, stale: false, problem: null },
          },
        ],
        visible: [],
        visibleError: null,
      },
    ],
  }
}

const props = (copyMode: 'all' | 'docs' = 'all', form: unknown = null) =>
  ({ data: data(copyMode), form, params: {} }) as never

describe('/drive/github: which files a repo copies', () => {
  let submitted: HTMLFormElement[]
  beforeEach(() => {
    submitted = []
    vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(function (
      this: HTMLFormElement,
    ) {
      submitted.push(this)
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it('shows the current mode per repo, and where the files land in Drive', async () => {
    render(GitHubPage, props('all'))
    const select = page.getByTestId('repos-copy-mode-kindred/shop')
    await expect.element(select).toHaveValue('all')
    await expect
      .element(page.getByTestId('repos-status-kindred/shop'))
      .toHaveTextContent('GitHub / kindred/shop / main')
  })

  it('switching to docs only asks first: cancel keeps all files and posts nothing', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(GitHubPage, props('all'))
    const select = page.getByTestId('repos-copy-mode-kindred/shop')
    await select.selectOptions('docs')
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Every file that is not Markdown'))
    await expect.element(select).toHaveValue('all')
    expect(submitted).toHaveLength(0)
  })

  it('switching to docs only, confirmed, posts the repo and the mode', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(GitHubPage, props('all'))
    await page.getByTestId('repos-copy-mode-kindred/shop').selectOptions('docs')
    expect(submitted).toHaveLength(1)
    const form = new FormData(submitted[0]!)
    expect(submitted[0]!.getAttribute('action')).toBe('?/setCopyMode')
    expect(form.get('repoId')).toBe('4242')
    expect(form.get('mode')).toBe('docs')
  })

  it('switching back to all files posts without asking (nothing is removed)', async () => {
    const confirm = vi.spyOn(window, 'confirm')
    render(GitHubPage, props('docs'))
    await page.getByTestId('repos-copy-mode-kindred/shop').selectOptions('all')
    expect(confirm).not.toHaveBeenCalled()
    expect(submitted).toHaveLength(1)
    expect(new FormData(submitted[0]!).get('mode')).toBe('all')
  })

  it('says what changed after the post, or why it failed', async () => {
    const { rerender } = render(
      GitHubPage,
      props('docs', {
        action: 'setCopyMode',
        ok: true,
        fullName: 'kindred/shop',
        copyMode: 'docs',
      }),
    )
    await expect
      .element(page.getByTestId('repos-copy-mode-status'))
      .toHaveTextContent('kindred/shop now copies only the Markdown docs')
    await rerender(
      props('all', {
        action: 'setCopyMode',
        error: 'Choose all files or docs only.',
        agent: {
          attempted: 'Choosing what a synced GitHub repo copies into Drive',
          nextSteps: ['Check the mode.'],
        },
      }),
    )
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Choose all files or docs only.')
    await expect
      .element(page.getByRole('button', { name: 'Copy agent instructions' }))
      .toBeInTheDocument()
  })
})
