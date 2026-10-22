import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AddAppDialog from './add-app-dialog.svelte'

describe('add-app-dialog', () => {
  it('when open it offers the two ways to add an app, each with its destination', async () => {
    render(AddAppDialog, { props: { open: true, onOpenChange: () => {} } })
    await expect.element(page.getByText('Add an app')).toBeInTheDocument()
    expect((await page.getByTestId('add-app-option').elements()).length).toBe(2)
    // Chat prefill: a draft, never an auto-send.
    await expect
      .element(page.getByRole('link', { name: /Build it with chat/ }))
      .toHaveAttribute('href', '/?prefill=Build%20me%20an%20app%3A%20')
    await expect
      .element(page.getByRole('link', { name: /Connect a repo/ }))
      .toHaveAttribute('href', '/m/website/apps/new')
    await expect
      .element(page.getByText('Describe an app or website and build it with your agent.'))
      .toBeInTheDocument()
    await expect
      .element(
        page.getByText(
          'Public or private GitHub repositories. Private repos use a read-only deploy key.',
        ),
      )
      .toBeInTheDocument()
    // Static sites are not a separate path: they are an app built with the agent in chat.
    expect(page.getByRole('link', { name: /Static site/ }).query()).toBeNull()
  })

  it('when closed nothing is rendered', async () => {
    render(AddAppDialog, { props: { open: false, onOpenChange: () => {} } })
    expect((await page.getByText('Add an app').elements()).length).toBe(0)
  })
})
