import { describe, expect, it } from 'vitest'
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
    const button = page.getByRole('button', { name: 'Connect GitHub' })
    await expect.element(button).toBeInTheDocument()
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
})
