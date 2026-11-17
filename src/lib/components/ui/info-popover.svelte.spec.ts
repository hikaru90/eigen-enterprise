import { createRawSnippet } from 'svelte'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import InfoPopover from './info-popover.svelte'

const children = createRawSnippet(() => ({ render: () => '<p>Only you and admins see it.</p>' }))

describe('info-popover.svelte (a "?" in place of an info box)', () => {
  it('is a named button that opens the text; Esc closes it and focus goes back to the button', async () => {
    render(InfoPopover, { label: 'Who can see this?', children, testid: 'info' })
    const button = page.getByRole('button', { name: 'Who can see this?' })
    await expect.element(page.getByText('Only you and admins see it.')).not.toBeInTheDocument()
    await button.click()
    const panel = page.getByTestId('info-panel')
    await expect.element(panel).toBeVisible()
    await expect.element(panel).toHaveTextContent('Who can see this?')
    await expect.element(panel).toHaveTextContent('Only you and admins see it.')
    await expect.element(button).toHaveAttribute('aria-expanded', 'true')
    await userEvent.keyboard('{Escape}')
    await expect.element(panel).not.toBeInTheDocument()
    await expect.element(button).toHaveFocus()
    await expect.element(button).toHaveAttribute('aria-expanded', 'false')
  })
})
