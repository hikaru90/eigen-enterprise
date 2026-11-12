import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import StatusPill from './status-pill.svelte'

/** Tailwind is not loaded in component specs, so the token classes are what is checked. */
describe('status-pill', () => {
  it('shows "on" with the green success dot, not the brand colour', async () => {
    render(StatusPill, { props: { label: 'Active', on: true } })
    const pill = page.getByTestId('module-status')
    await expect.element(pill).toHaveTextContent('Active')
    const dot = pill.element().querySelector('[aria-hidden="true"]')
    expect(dot?.classList.contains('bg-success')).toBe(true)
    expect(dot?.classList.contains('bg-primary')).toBe(false)
  })

  it('keeps "off" muted', async () => {
    render(StatusPill, { props: { label: 'Not active', on: false } })
    const pill = page.getByTestId('module-status')
    await expect.element(pill).toHaveClass('text-muted-foreground')
    const dot = pill.element().querySelector('[aria-hidden="true"]')
    expect(dot?.classList.contains('bg-muted-foreground/40')).toBe(true)
    expect(dot?.classList.contains('bg-success')).toBe(false)
  })

  it('sets the label at the 13px floor (text-xs), never an arbitrary smaller size', async () => {
    render(StatusPill, { props: { label: 'Active', on: true } })
    const pill = page.getByTestId('module-status')
    await expect.element(pill).toHaveClass('text-xs')
    expect(pill.element().className).not.toMatch(/text-\[/)
  })
})
