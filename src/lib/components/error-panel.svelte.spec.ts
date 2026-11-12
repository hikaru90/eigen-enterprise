import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))

import ErrorPanel from './error-panel.svelte'

describe('error-panel.svelte', () => {
  it('a 403 is a human "no access" page with the way back — never "Something went wrong / Forbidden"', async () => {
    render(ErrorPanel, { status: 403, message: 'Forbidden', signedIn: true })
    await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent("You don't have access to this page")
    await expect.element(page.getByText('Ask an owner or an admin if you need it.')).toBeInTheDocument()
    await expect.element(page.getByTestId('error-back')).toHaveAttribute('href', '/')
    await expect.element(page.getByText('Something went wrong')).not.toBeInTheDocument()
    await expect.element(page.getByText('Forbidden')).not.toBeInTheDocument()
    await expect.element(page.getByText('Error 403')).not.toBeInTheDocument()
  })

  it('a signed-out 403 offers Sign in', async () => {
    render(ErrorPanel, { status: 403, message: 'Forbidden', signedIn: false })
    await expect.element(page.getByTestId('error-back')).toHaveAttribute('href', '/login')
  })

  it('a 404 still says the page was not found', async () => {
    render(ErrorPanel, { status: 404, message: 'Not Found', signedIn: true })
    await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found')
  })

  it('a switched-off plugin, for the owner/admin: says so and links to Settings → Plugins (no "not found", no code)', async () => {
    render(ErrorPanel, { status: 404, message: 'Drive is switched off', signedIn: true, pluginOff: { id: 'drive', name: 'Drive', canManage: true } })
    await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Drive is switched off')
    await expect.element(page.getByTestId('plugin-off-switch')).toHaveAttribute('href', '/settings/modules')
    await expect.element(page.getByText('Page not found')).not.toBeInTheDocument()
    await expect.element(page.getByText('Error 404')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('error-back')).toHaveAttribute('href', '/')
  })

  it('a switched-off plugin, for a member: says so and to ask an admin (no switch link)', async () => {
    render(ErrorPanel, { status: 404, message: 'Drive is switched off', signedIn: true, pluginOff: { id: 'drive', name: 'Drive', canManage: false } })
    await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Drive is switched off')
    await expect.element(page.getByText('Ask an admin to switch it on.')).toBeInTheDocument()
    await expect.element(page.getByTestId('plugin-off-switch')).not.toBeInTheDocument()
  })

  it('other errors keep the status and the message', async () => {
    render(ErrorPanel, { status: 500, message: 'The database is down.', signedIn: true })
    await expect.element(page.getByRole('heading', { level: 1 })).toHaveTextContent('Something went wrong')
    await expect.element(page.getByText('Error 500')).toBeInTheDocument()
    await expect.element(page.getByText('The database is down.')).toBeInTheDocument()
  })
})
