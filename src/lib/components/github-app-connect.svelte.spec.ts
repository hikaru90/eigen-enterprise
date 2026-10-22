import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import GitHubAppConnect from './github-app-connect.svelte'

const notConnected = { connected: false, installed: false, appSlug: null, manageUrl: null }
const created = {
  connected: true,
  installed: false,
  appSlug: 'eigen-kindred',
  manageUrl: 'https://github.com/apps/eigen-kindred/installations/new',
}
const installed = {
  connected: true,
  installed: true,
  appSlug: 'eigen-kindred',
  manageUrl: 'https://github.com/apps/eigen-kindred/installations/new',
}

describe('github-app-connect.svelte', () => {
  it('not connected: plain steps and a Connect GitHub form posting the manifest to GitHub', async () => {
    render(GitHubAppConnect, {
      github: notConnected,
      manifest: { json: '{"name":"x"}', state: 's1' },
    })
    const button = page.getByTestId('github-connect-start')
    await expect.element(button).toBeVisible()
    const form = button.element().closest('form')!
    expect(form.getAttribute('action')).toBe('https://github.com/settings/apps/new?state=s1')
    expect(form.querySelector('input[name="manifest"]')?.getAttribute('value')).toBe('{"name":"x"}')
    await page.getByLabelText(/GitHub organization/).fill('kindred')
    expect(form.getAttribute('action')).toBe(
      'https://github.com/organizations/kindred/settings/apps/new?state=s1',
    )
    await expect
      .element(page.getByText(/It can only read code, and only of repos you pick/))
      .toBeInTheDocument()
  })

  it('created but not installed: the install link points at GitHub', async () => {
    render(GitHubAppConnect, { github: created, manifest: null })
    await expect
      .element(page.getByTestId('github-app-not-installed').getByText(/not installed yet/))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'Install it on your repositories' }))
      .toHaveAttribute('href', 'https://github.com/apps/eigen-kindred/installations/new')
  })

  it('installed: an Installed badge, the app slug, and a manage link — no add-an-app card (it lives inside that flow)', async () => {
    render(GitHubAppConnect, { github: installed, manifest: null })
    await expect.element(page.getByTestId('github-installed-badge')).toHaveTextContent('Installed')
    await expect.element(page.getByText(/Connected through the GitHub App/)).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'Manage the installation on GitHub' }))
      .toHaveAttribute('href', 'https://github.com/apps/eigen-kindred/installations/new')
    expect(page.getByTestId('github-repos-note').query()).toBeNull()
  })
})
