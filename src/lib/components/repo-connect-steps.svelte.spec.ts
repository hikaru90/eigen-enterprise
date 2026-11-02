import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import RepoConnectSteps, { type RepoConnectData } from './repo-connect-steps.svelte'

/**
 * The stepper is driven by clicks alone: the current step is $state moved by
 * submit handlers (via a fake `$app/forms` enhance that answers with canned
 * action results) and by plain onclick handlers — never an $effect.
 */

const { results } = vi.hoisted(() => ({ results: new Map<string, unknown>() }))

vi.mock('$app/forms', () => ({
  enhance: (form: HTMLFormElement, fn?: () => unknown) => {
    const handler = async (event: Event) => {
      event.preventDefault()
      const inner = fn?.() as
        | ((o: {
            result: unknown
            update: (o?: { reset?: boolean }) => Promise<void>
          }) => Promise<void>)
        | undefined
      const action = form.getAttribute('action') ?? ''
      const result = results.get(action) ?? { type: 'success', data: {} }
      await inner?.({ result, update: async () => undefined })
    }
    form.addEventListener('submit', handler)
    return { destroy: () => form.removeEventListener('submit', handler) }
  },
}))

const KEY_ID = 'dk_' + '0'.repeat(24)
const PUBLIC_KEY = 'ssh-ed25519 AAAAPUBLIC ee-deploy'
const inspected = (
  fullName: string,
  visibility: 'public' | 'private',
  installationId: number | null,
) => ({
  fullName,
  visibility,
  defaultBranch: 'main',
  branches: ['main', 'dev'],
  installationId,
})

const data: RepoConnectData = {
  ownerId: 'u1',
  github: { connected: false, installed: false, appSlug: null, manageUrl: null },
  githubManifest: null,
  repos: [
    {
      fullName: 'kindred/site',
      branch: 'main',
      htmlUrl: 'https://github.com/kindred/site',
      visibility: 'public',
      authKind: 'public',
      used: true,
      usedBy: 'site',
      suggestedName: 'site-2',
    },
    {
      fullName: 'kindred/secret',
      branch: 'dev',
      htmlUrl: 'https://github.com/kindred/secret',
      visibility: 'private',
      authKind: 'deploy_key',
      used: false,
      usedBy: null,
      suggestedName: 'secret',
    },
  ],
  available: null,
  availableError: null,
  takenNames: ['site'],
  catalog: { runtimes: { node: ['22'] } },
  appsError: null,
  managed: true,
  consoleHost: 'os.ee.localhost',
  managedReason: null,
}

const hidden = (name: string): string => {
  const el = document.querySelector(`input[name="${name}"]`)
  return el instanceof HTMLInputElement ? el.value : ''
}

afterEach(() => {
  sessionStorage.clear()
  results.clear()
  vi.unstubAllGlobals()
})

describe('repo-connect-steps.svelte', () => {
  it('keeps server availability out of repository selection and explains it at deployment', async () => {
    render(RepoConnectSteps, { data: { ...data, managed: false, consoleHost: null } })
    expect(page.getByTestId('not-managed').query()).toBeNull()
    await page.getByTestId('use-kindred/secret').click()
    await expect
      .element(page.getByTestId('not-managed'))
      .toHaveTextContent('Connect a deployment server')
    await expect
      .element(page.getByRole('link', { name: 'Back to apps' }))
      .toHaveAttribute('href', '/m/website')
  })

  it('starts a private repository with a deploy key without a failing public lookup', async () => {
    results.set('?/deployKeyCreate', {
      type: 'success',
      data: {
        repo: 'kindred/vault',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        addKeyUrl: 'https://github.com/kindred/vault/settings/keys/new',
      },
    })
    render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await page.getByRole('radio', { name: 'Private repository' }).click()
    await page.getByLabelText('Repository link').fill('git@github.com:kindred/vault.git')
    await page.getByTestId('check-link').click()
    await expect.element(page.getByTestId('step-access')).toBeInTheDocument()
    await expect.element(page.getByLabelText('Public key')).toHaveValue(PUBLIC_KEY)
    await expect
      .element(page.getByRole('button', { name: 'Choose a different repo' }))
      .toBeDisabled()
    results.set('?/deployKeyCancel', { type: 'success', data: { ok: true } })
    await page.getByRole('button', { name: 'Cancel and delete the key' }).click()
    await expect.element(page.getByTestId('step-repository')).toBeInTheDocument()
  })

  it('explains the server requirement beside private access while allowing public connections', async () => {
    render(RepoConnectSteps, { data: { ...data, repos: [], managed: false, consoleHost: null } })
    await page.getByRole('radio', { name: 'Private repository' }).click()
    await expect.element(page.getByTestId('check-link')).toBeDisabled()
    await expect
      .element(page.getByText(/A deployment server is needed to generate and store/))
      .toBeInTheDocument()
    await page.getByRole('radio', { name: 'Public repository' }).click()
    await expect.element(page.getByTestId('check-link')).not.toBeDisabled()
  })

  it('preselects a connected repository from the overview link', async () => {
    render(RepoConnectSteps, { data: { ...data, repoHint: 'kindred/secret' } })
    await expect.element(page.getByTestId('step-app')).toBeInTheDocument()
    await expect.element(page.getByLabelText('App name')).toHaveValue('secret')
    expect(hidden('repo')).toBe('kindred/secret')
  })

  it('preselects the exact connected branch when a repository has several branches', async () => {
    render(RepoConnectSteps, {
      data: {
        ...data,
        repoHint: 'kindred/site',
        branchHint: 'preview/features',
        repos: [
          data.repos[0],
          { ...data.repos[0], branch: 'preview/features', used: false, usedBy: null },
        ],
      },
    })
    await expect.element(page.getByTestId('step-app')).toBeInTheDocument()
    expect(hidden('repo')).toBe('kindred/site')
    expect(hidden('branch')).toBe('preview/features')
  })

  it('does not choose another branch when the requested branch is absent', async () => {
    render(RepoConnectSteps, {
      data: { ...data, repoHint: 'kindred/site', branchHint: 'missing-branch' },
    })
    await expect.element(page.getByTestId('step-repository')).toBeInTheDocument()
    expect(page.getByTestId('step-app').query()).toBeNull()
    await expect
      .element(page.getByTestId('step-notice'))
      .toHaveTextContent('kindred/site (missing-branch) is not connected.')
    await expect.element(page.getByLabelText('Repository link')).toHaveValue('kindred/site')
  })

  it('resumes a generated key after unmount and requires a fresh access check', async () => {
    results.set('?/deployKeyCreate', {
      type: 'success',
      data: {
        action: 'deploy_key',
        repo: 'kindred/vault',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        addKeyUrl: 'https://github.com/kindred/vault/settings/keys/new',
      },
    })
    const first = render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await page.getByRole('radio', { name: 'Private repository' }).click()
    await page.getByLabelText('Repository link').fill('kindred/vault')
    await page.getByTestId('check-link').click()
    await expect.element(page.getByLabelText('Public key')).toHaveValue(PUBLIC_KEY)
    expect(JSON.parse(sessionStorage.getItem('ee:github:pending-deploy-key:u1')!)).toEqual({
      repo: 'kindred/vault',
      keyId: KEY_ID,
      publicKey: PUBLIC_KEY,
    })
    await first.unmount()
    render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await expect.element(page.getByTestId('step-access')).toBeInTheDocument()
    await expect.element(page.getByLabelText('Public key')).toHaveValue(PUBLIC_KEY)
    expect(page.getByRole('button', { name: 'Continue', exact: true }).query()).toBeNull()
    results.set('?/deployKeyCancel', { type: 'success', data: { ok: true } })
    await page.getByRole('button', { name: 'Cancel and delete the key' }).click()
    expect(sessionStorage.getItem('ee:github:pending-deploy-key:u1')).toBeNull()
    await expect.element(page.getByTestId('step-repository')).toBeInTheDocument()
  })

  it('recovers native POST key results and clears saved setup after connecting', async () => {
    render(RepoConnectSteps, {
      data: { ...data, repos: [] },
      nativeResult: {
        action: 'deploy_key',
        repo: 'kindred/vault',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
      },
    })
    await expect.element(page.getByLabelText('Public key')).toHaveValue(PUBLIC_KEY)
    await expect
      .element(page.getByRole('link', { name: "Open the repo's deploy keys on GitHub" }))
      .toHaveAttribute('href', 'https://github.com/kindred/vault/settings/keys/new')
    results.set('?/deployKeyCheck', {
      type: 'success',
      data: { branches: ['main'], branch: 'main' },
    })
    await page.getByRole('button', { name: 'Check access' }).click()
    results.set('?/connect', { type: 'success', data: { action: 'connect', ok: true } })
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect.element(page.getByTestId('step-app')).toBeInTheDocument()
    expect(sessionStorage.getItem('ee:github:pending-deploy-key:u1')).toBeNull()
  })

  it('does not expose another owner’s pending setup', async () => {
    sessionStorage.setItem(
      'ee:github:pending-deploy-key:another-owner',
      JSON.stringify({ repo: 'kindred/vault', keyId: KEY_ID, publicKey: PUBLIC_KEY }),
    )
    render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await expect.element(page.getByTestId('step-repository')).toBeInTheDocument()
    expect(page.getByLabelText('Public key').query()).toBeNull()
  })

  it('step 1 lists connected repos; only unused ones can be disconnected; Use jumps to step 3 with a free name and a derived host', async () => {
    render(RepoConnectSteps, { data })
    await expect.element(page.getByTestId('step-repository')).toBeInTheDocument()
    expect(page.getByTestId('step-app').query()).toBeNull()
    // A repo a service already deploys keeps its Use but loses its Disconnect.
    expect(page.getByTestId('use-kindred/site').query()).not.toBeNull()
    expect(page.getByRole('button', { name: 'Disconnect kindred/site (main)' }).query()).toBeNull()
    expect(
      page.getByRole('button', { name: 'Disconnect kindred/secret (dev)' }).query(),
    ).not.toBeNull()
    expect(page.getByText(/in use by site/)).toBeInTheDocument()

    await page.getByTestId('use-kindred/secret').click()
    await expect.element(page.getByTestId('step-app')).toBeInTheDocument()
    await expect.element(page.getByLabelText('App name')).toHaveValue('secret')
    await expect.element(page.getByLabelText('Domain')).toHaveValue('secret.ee.localhost')
    expect(hidden('repo')).toBe('kindred/secret')
    expect(hidden('branch')).toBe('dev')

    // A suggested name that is taken gets the next free variant.
    await page.getByRole('radio', { name: /Back-end service/ }).click()
    expect(hidden('kind')).toBe('backend')
  })

  it('a public repo: inspect leads to access without any deploy-key steps, and Continue connects by link', async () => {
    results.set('?/inspect', {
      type: 'success',
      data: {
        action: 'inspect',
        branch: 'main',
        inspected: inspected('kindred/site', 'public', null),
      },
    })
    results.set('?/connect', {
      type: 'success',
      data: { action: 'connect', ok: true, message: 'Connected kindred/site (main).' },
    })
    render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await page.getByLabelText('Repository link').fill('https://github.com/kindred/site')
    await page.getByTestId('check-link').click()

    await expect.element(page.getByTestId('step-access')).toBeInTheDocument()
    await expect.element(page.getByText('Public repo — no key needed')).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Create a deploy key' }).query()).toBeNull()
    expect(page.getByLabelText('Public key').query()).toBeNull()

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.element(page.getByTestId('step-app')).toBeInTheDocument()
    await expect.element(page.getByLabelText('App name')).toHaveValue('site-2')
    expect(hidden('repo')).toBe('kindred/site')
    expect(hidden('branch')).toBe('main')
  })

  it('a private repo: the key steps only appear here — create, copy, check, then Continue connects with the key', async () => {
    results.set('?/inspect', {
      type: 'success',
      data: {
        action: 'inspect',
        branch: 'main',
        inspected: inspected('kindred/secret', 'private', null),
      },
    })
    results.set('?/deployKeyCreate', {
      type: 'success',
      data: {
        action: 'deploy_key',
        repo: 'kindred/secret',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
      },
    })
    results.set('?/deployKeyCheck', {
      type: 'success',
      data: {
        action: 'deploy_key',
        repo: 'kindred/secret',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        branches: ['dev', 'main'],
        branch: 'main',
      },
    })
    results.set('?/connect', {
      type: 'success',
      data: { action: 'connect', ok: true, message: 'Connected kindred/secret (main).' },
    })
    // The headless browser denies clipboard writes unless the test provides one.
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await page.getByLabelText('Repository link').fill('kindred/secret')
    await page.getByTestId('check-link').click()

    await expect.element(page.getByTestId('step-access')).toBeInTheDocument()
    await expect.element(page.getByText(/Private repo — it needs a deploy key/)).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Continue' }).query()).toBeNull()

    await page.getByRole('button', { name: 'Create a deploy key' }).click()
    await expect.element(page.getByLabelText('Public key')).toHaveValue(PUBLIC_KEY)
    await page.getByRole('button', { name: 'Copy key' }).click()
    expect(writeText).toHaveBeenCalledWith(PUBLIC_KEY)
    await expect.element(page.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: "Open the repo's deploy keys on GitHub" }))
      .toHaveAttribute('href', 'https://github.com/kindred/secret/settings/keys/new')
    await expect.element(page.getByText(/Leave “Allow write access” off/)).toBeInTheDocument()
    expect(document.body.innerHTML).not.toMatch(/PRIVATE KEY/)

    await page.getByRole('button', { name: 'Check access' }).click()
    await expect.element(page.getByText('GitHub accepted the key.')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeInTheDocument()
    // The connect carries the key: repo + branch + its id, and nothing secret.
    expect(hidden('repo')).toBe('kindred/secret')
    expect(hidden('branch')).toBe('main')
    expect(hidden('keyId')).toBe(KEY_ID)

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.element(page.getByTestId('step-app')).toBeInTheDocument()
    await expect.element(page.getByLabelText('App name')).toHaveValue('secret')
    expect(hidden('repo')).toBe('kindred/secret')
    expect(hidden('branch')).toBe('main')
    // The deploy-key repo gets no push-to-deploy.
    expect(page.getByText(/no push-to-deploy/)).toBeInTheDocument()
    expect(page.getByText(/Deploy automatically on every push/).query()).toBeNull()
  })

  it('without the GitHub App, the App connection is offered right here — no repo form', async () => {
    render(RepoConnectSteps, {
      data: { ...data, githubManifest: { json: '{}', state: 'st-1' } },
    })
    await page.getByText('Advanced: connect through a GitHub App', { exact: true }).click()
    await expect.element(page.getByText(/Connect the GitHub App here/)).toBeInTheDocument()
    await expect.element(page.getByTestId('github-connect-app')).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Choose' }).query()).toBeNull()
  })

  it('a private repo GitHub will not show: the deploy-key flow starts on step 1 instead of a dead end', async () => {
    results.set('?/inspect', {
      type: 'failure',
      data: {
        action: 'inspect',
        repo: 'kindred/secret',
        keyPath: true,
        error:
          'GitHub has no public repository kindred/secret. If it is private, connect it with a deploy key.',
      },
    })
    results.set('?/deployKeyCreate', {
      type: 'success',
      data: {
        action: 'deploy_key',
        repo: 'kindred/secret',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
      },
    })
    results.set('?/deployKeyCheck', {
      type: 'success',
      data: {
        action: 'deploy_key',
        repo: 'kindred/secret',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        branches: ['dev', 'main'],
        branch: 'main',
      },
    })
    results.set('?/connect', {
      type: 'success',
      data: { action: 'connect', ok: true, message: 'Connected kindred/secret (main).' },
    })
    render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await page.getByLabelText('Repository link').fill('kindred/secret')
    await page.getByTestId('check-link').click()

    // Still on step 1 — with the key path offered, not a dead end.
    await expect.element(page.getByTestId('step-repository')).toBeInTheDocument()
    await expect.element(page.getByTestId('step-error')).toBeInTheDocument()
    await expect.element(page.getByTestId('private-key-path')).toBeInTheDocument()
    await expect.element(page.getByText(/Private repo — it needs a deploy key/)).toBeInTheDocument()

    await page.getByRole('button', { name: 'Create a deploy key' }).click()
    await expect.element(page.getByLabelText('Public key')).toHaveValue(PUBLIC_KEY)
    await page.getByRole('button', { name: 'Check access' }).click()
    await expect.element(page.getByText('GitHub accepted the key.')).toBeInTheDocument()
    expect(hidden('repo')).toBe('kindred/secret')
    expect(hidden('keyId')).toBe(KEY_ID)

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.element(page.getByTestId('step-app')).toBeInTheDocument()
    expect(hidden('repo')).toBe('kindred/secret')
  })

  it('when the server is not managed by ee: an explicit alert, deploy off — connecting still works', async () => {
    render(RepoConnectSteps, {
      data: { ...data, managed: false, consoleHost: null, managedReason: 'connect ECONNREFUSED' },
    })
    await page.getByTestId('use-kindred/secret').click()
    await expect.element(page.getByTestId('not-managed')).toBeInTheDocument()
    const deploy = page.getByRole('button', { name: 'Deploy', exact: true })
    await expect.element(deploy).toBeDisabled()
    // The name can no longer be derived from a console host; the field stays empty.
    await expect.element(page.getByLabelText('Domain')).toHaveValue('')
  })

  it('Deploy starts in the background, the page follows the job, and a live deploy links to the app', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        calls.push(String(url))
        return new Response(
          JSON.stringify({
            jobId: 'job-1',
            name: 'secret',
            state: 'live',
            stage: 'live',
            stages: [],
            failedStage: null,
            error: null,
            deployId: 'd1',
            lines: ['listening'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }),
    )
    results.set('?/deploy', {
      type: 'success',
      data: { action: 'deploy', name: 'secret', jobId: 'job-1' },
    })
    render(RepoConnectSteps, { data })
    await page.getByTestId('use-kindred/secret').click()
    await page.getByRole('button', { name: 'Deploy', exact: true }).click()

    await expect.element(page.getByTestId('deploy-progress')).toBeInTheDocument()
    await expect.element(page.getByText('secret is live.')).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'Open secret' }))
      .toHaveAttribute('href', '/m/website/apps/secret')
    expect(calls.some((c) => c.includes('/m/website/apps/secret/deploy-progress?job=job-1'))).toBe(
      true,
    )
  })

  it('a failed action shows its plain sentence; Cancel clears the pending key', async () => {
    results.set('?/inspect', {
      type: 'failure',
      data: { action: 'inspect', repo: 'nope', error: 'GitHub has no public repository nope.' },
    })
    results.set('?/deployKeyCancel', {
      type: 'success',
      data: {
        action: 'deploy_key_cancel',
        ok: true,
        message: 'Deleted the unused deploy key for kindred/secret on this server.',
      },
    })
    results.set('?/deployKeyCreate', {
      type: 'success',
      data: {
        action: 'deploy_key',
        repo: 'kindred/secret',
        keyId: KEY_ID,
        publicKey: PUBLIC_KEY,
        addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
      },
    })
    render(RepoConnectSteps, { data: { ...data, repos: [] } })
    await page.getByLabelText('Repository link').fill('nope')
    await page.getByTestId('check-link').click()
    await expect
      .element(page.getByTestId('step-error'))
      .toHaveTextContent('GitHub has no public repository nope.')

    // Cancel removes the pending key and says so.
    results.set('?/inspect', {
      type: 'success',
      data: {
        action: 'inspect',
        branch: 'main',
        inspected: inspected('kindred/secret', 'private', null),
      },
    })
    await page.getByLabelText('Repository link').fill('kindred/secret')
    await page.getByTestId('check-link').click()
    await page.getByRole('button', { name: 'Create a deploy key' }).click()
    await expect.element(page.getByLabelText('Public key')).toHaveValue(PUBLIC_KEY)
    await page.getByRole('button', { name: 'Cancel and delete the key' }).click()
    await expect
      .element(page.getByTestId('step-notice'))
      .toHaveTextContent('Deleted the unused deploy key for kindred/secret on this server.')
    expect(page.getByLabelText('Public key').query()).toBeNull()
  })
})
