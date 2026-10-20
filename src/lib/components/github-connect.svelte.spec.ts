import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import GitHubConnect from './github-connect.svelte'

const notConnected = { connected: false, installed: false, appSlug: null, manageUrl: null }
const installed = {
  connected: true,
  installed: true,
  appSlug: 'eigen-kindred',
  manageUrl: 'https://github.com/apps/eigen-kindred/installations/new',
}
const base = { repos: [], available: null, availableError: null, manifest: null, form: null }

describe('github-connect.svelte', () => {
  it('not connected: plain steps and a Connect GitHub form posting the manifest to GitHub', async () => {
    render(GitHubConnect, {
      ...base,
      github: notConnected,
      manifest: { json: '{"name":"x"}', state: 's1' },
    })
    // The App is off the main flow: collapsed under Advanced until opened.
    const advanced = page.getByTestId('github-advanced')
    expect((advanced.element() as HTMLDetailsElement).open).toBe(false)
    await page.getByText('Advanced: connect through a GitHub App').click()
    const button = page.getByRole('button', { name: 'Connect GitHub' })
    await expect.element(button).toBeVisible()
    const form = button.element().closest('form')!
    expect(form.getAttribute('action')).toBe('https://github.com/settings/apps/new?state=s1')
    await page.getByLabelText(/GitHub organization/).fill('kindred')
    expect(form.getAttribute('action')).toBe(
      'https://github.com/organizations/kindred/settings/apps/new?state=s1',
    )
    await expect.element(page.getByText(/It can only read code/)).toBeInTheDocument()
  })

  it('installed: lists repos the app can see and links to add more on GitHub', async () => {
    render(GitHubConnect, {
      ...base,
      github: installed,
      available: [{ fullName: 'kindred/app', visibility: 'private', defaultBranch: 'main' }],
    })
    await expect.element(page.getByText('kindred/app')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Choose' })).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'Add more repos on GitHub' }))
      .toHaveAttribute('href', 'https://github.com/apps/eigen-kindred/installations/new')
  })

  it('after a check: a branch picker preselects the branch', async () => {
    render(GitHubConnect, {
      ...base,
      github: notConnected,
      form: {
        action: 'inspect',
        repo: 'https://github.com/kindred/site',
        branch: 'dev',
        inspected: {
          fullName: 'kindred/site',
          visibility: 'public',
          defaultBranch: 'main',
          branches: ['main', 'dev'],
        },
      },
    })
    await expect.element(page.getByLabelText('Branch')).toHaveValue('dev')
    await expect
      .element(page.getByRole('button', { name: 'Connect', exact: true }))
      .toBeInTheDocument()
  })

  it('connected repos show branch, visibility, last commit, and a Disconnect action', async () => {
    render(GitHubConnect, {
      ...base,
      github: installed,
      available: [],
      repos: [
        {
          fullName: 'kindred/site',
          branch: 'main',
          htmlUrl: 'https://github.com/kindred/site',
          visibility: 'public',
          lastCommit: { sha: 'abcdef1234567890', message: 'Init', date: '2026-10-02T00:00:00Z' },
          lastCommitError: null,
        },
        {
          fullName: 'kindred/app',
          branch: 'gone',
          htmlUrl: 'https://github.com/kindred/app',
          visibility: 'private',
          lastCommit: null,
          lastCommitError: 'GitHub could not find the branch gone.',
        },
      ],
    })
    await expect
      .element(page.getByText(/main · public · abcdef1 “Init” \(2026-10-02\)/))
      .toBeInTheDocument()
    await expect
      .element(page.getByText(/GitHub could not find the branch gone\./))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Disconnect kindred/site (main)' }))
      .toBeInTheDocument()
  })

  it('a failed action shows its plain message as an alert', async () => {
    render(GitHubConnect, {
      ...base,
      github: notConnected,
      form: {
        action: 'inspect',
        repo: 'x',
        error: 'Only github.com repositories can be connected.',
      },
    })
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Only github.com repositories can be connected.')
  })

  it('deploy key, step 1: a repo field (https or SSH form) and a Make a deploy key button', async () => {
    render(GitHubConnect, { ...base, github: notConnected })
    const section = page.getByTestId('github-deploy-key')
    await expect
      .element(section.getByRole('heading', { name: 'Connect a private repo with a deploy key' }))
      .toBeInTheDocument()
    const button = section.getByRole('button', { name: 'Make a deploy key' })
    expect(button.element().closest('form')!.getAttribute('action')).toBe('?/deployKeyCreate')
    await expect.element(section.getByLabelText('Private repository')).toBeVisible()
  })

  it('deploy key, step 2: shows the public key with a copy button, plain steps and a link to GitHub', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    render(GitHubConnect, {
      ...base,
      github: notConnected,
      form: {
        action: 'deploy_key',
        step: 'add',
        repo: 'kindred/secret',
        keyId: 'dk_000000000000000000000001',
        publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy',
        addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
      },
    })
    await expect
      .element(page.getByLabelText('Public key'))
      .toHaveValue('ssh-ed25519 AAAAPUBLIC ee-deploy')
    await page.getByRole('button', { name: 'Copy key' }).click()
    expect(writeText).toHaveBeenCalledWith('ssh-ed25519 AAAAPUBLIC ee-deploy')
    await expect.element(page.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: "Open the repo's deploy keys on GitHub" }))
      .toHaveAttribute('href', 'https://github.com/kindred/secret/settings/keys/new')
    await expect.element(page.getByText(/Leave “Allow write access” off/)).toBeInTheDocument()
    const check = page.getByRole('button', { name: 'Check access' })
    expect(check.element().closest('form')!.getAttribute('action')).toBe('?/deployKeyCheck')
    // The page never holds the private key: only the public key and the id travel.
    expect(document.body.innerHTML).not.toMatch(/PRIVATE KEY/)
  })

  it('deploy key: a failed check shows the plain message as an alert', async () => {
    render(GitHubConnect, {
      ...base,
      github: notConnected,
      form: {
        action: 'deploy_key',
        step: 'add',
        repo: 'kindred/secret',
        keyId: 'dk_000000000000000000000001',
        publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy',
        addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
        error:
          "GitHub didn't accept the key yet — check it was added to this repo (Settings → Deploy keys).",
      },
    })
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent("GitHub didn't accept the key yet — check it was added to this repo")
  })

  it('deploy key, step 3: after a good check the owner picks a branch and connects', async () => {
    render(GitHubConnect, {
      ...base,
      github: notConnected,
      form: {
        action: 'deploy_key',
        step: 'branches',
        repo: 'kindred/secret',
        keyId: 'dk_000000000000000000000001',
        publicKey: 'ssh-ed25519 AAAAPUBLIC ee-deploy',
        addKeyUrl: 'https://github.com/kindred/secret/settings/keys/new',
        branches: ['dev', 'main'],
        branch: 'main',
      },
    })
    await expect.element(page.getByLabelText('Branch')).toHaveValue('main')
    const connect = page.getByRole('button', { name: 'Connect', exact: true })
    expect(connect.element().closest('form')!.getAttribute('action')).toBe('?/deployKeyConnect')
  })

  it('after disconnecting a deploy-key repo: says the key was deleted and links to GitHub to remove it', async () => {
    render(GitHubConnect, {
      ...base,
      github: notConnected,
      form: {
        action: 'disconnect',
        ok: true,
        message:
          'Disconnected kindred/secret (main) and deleted its deploy key on this server. You can remove the key on GitHub too.',
        link: {
          href: 'https://github.com/kindred/secret/settings/keys',
          label: 'Deploy keys of kindred/secret on GitHub',
        },
      },
    })
    await expect
      .element(page.getByRole('link', { name: 'Deploy keys of kindred/secret on GitHub' }))
      .toHaveAttribute('href', 'https://github.com/kindred/secret/settings/keys')
  })
})
