import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import CallRowSummary from './call-row-summary.svelte'

describe('call-row-summary.svelte (wish 397dfda6)', () => {
  it('offers "Make summary" and shows the summary it made', async () => {
    const brainRecap = vi.fn(async () => 'Decided: ship it.')
    render(CallRowSummary, { callId: 'c1', recap: null, client: { brainRecap } })
    await page.getByTestId('calls-summary-make').click()
    expect(brainRecap).toHaveBeenCalledWith('c1')
    await expect
      .element(page.getByTestId('calls-summary-text'))
      .toHaveTextContent('Decided: ship it.')
  })

  it('shows a kept summary without asking again', async () => {
    const brainRecap = vi.fn(async () => 'x')
    render(CallRowSummary, { callId: 'c1', recap: 'Kept summary.', client: { brainRecap } })
    await page.getByTestId('calls-summary-toggle').click()
    await expect.element(page.getByTestId('calls-summary-text')).toHaveTextContent('Kept summary.')
    await expect.element(page.getByTestId('calls-summary-make')).not.toBeInTheDocument()
    expect(brainRecap).not.toHaveBeenCalled()
  })
})
