import { createRawSnippet } from 'svelte'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import InfoPopover from './info-popover.svelte'

const children = createRawSnippet(() => ({
  render: () => '<p>Mail the agent sends for you shows up here.</p>',
}))

const trigger = () => page.getByRole('button', { name: 'About Email' })
const panel = () => page.getByRole('dialog', { name: 'About Email' })

describe('InfoPopover: page info on demand', () => {
  it('is a closed, always-present button; the content is not shown by default', async () => {
    render(InfoPopover, { label: 'About Email', children })
    await expect.element(trigger()).toBeVisible()
    await expect.element(trigger()).toHaveAttribute('aria-expanded', 'false')
    await expect.element(page.getByText('Mail the agent sends for you')).not.toBeInTheDocument()
  })

  it('opens the content on click, wired with aria-expanded and aria-controls', async () => {
    render(InfoPopover, { label: 'About Email', children })
    await trigger().click()
    await expect.element(panel()).toBeVisible()
    await expect.element(panel()).toHaveTextContent('Mail the agent sends for you shows up here.')
    await expect.element(trigger()).toHaveAttribute('aria-expanded', 'true')
    const id = panel().element().id
    expect(id).toBeTruthy()
    await expect.element(trigger()).toHaveAttribute('aria-controls', id)
  })

  it('closes on Escape and returns focus to the button', async () => {
    render(InfoPopover, { label: 'About Email', children })
    await trigger().click()
    await expect.element(panel()).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(panel()).not.toBeInTheDocument()
    await expect.element(trigger()).toHaveAttribute('aria-expanded', 'false')
    await expect.element(trigger()).toHaveFocus()
  })

  it('closes on a click outside', async () => {
    render(InfoPopover, { label: 'About Email', children })
    await trigger().click()
    await expect.element(panel()).toBeVisible()
    await userEvent.click(document.body, { position: { x: 5, y: 5 } })
    await expect.element(panel()).not.toBeInTheDocument()
  })

  it('opens again after closing — the info is never gone for good', async () => {
    render(InfoPopover, { label: 'About Email', children })
    await trigger().click()
    await userEvent.keyboard('{Escape}')
    await trigger().click()
    await expect.element(panel()).toBeVisible()
  })
})
