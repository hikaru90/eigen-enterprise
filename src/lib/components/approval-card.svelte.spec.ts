import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ApprovalCard from './approval-card.svelte'

const base = {
  action: 'Publish a page of your website',
  tool: 'website.publish_page',
  status: 'pending' as const,
  canDecide: true,
  deciding: false,
  error: null,
}

describe('approval-card.svelte', () => {
  it('names the action in plain words with Approve and Deny', async () => {
    const ondecide = vi.fn()
    render(ApprovalCard, { ...base, ondecide })
    await expect.element(page.getByText('Publish a page of your website')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Approve' }).click()
    expect(ondecide).toHaveBeenCalledWith('approved')
    await page.getByRole('button', { name: 'Deny' }).click()
    expect(ondecide).toHaveBeenCalledWith('denied')
  })

  it('locks the buttons while the decision is being sent and shows a failure inline', async () => {
    render(ApprovalCard, {
      ...base,
      deciding: true,
      error: 'That did not go through. Try again.',
      ondecide: vi.fn(),
    })
    await expect.element(page.getByRole('button', { name: 'Approve' })).toBeDisabled()
    await expect.element(page.getByRole('button', { name: 'Deny' })).toBeDisabled()
    await expect.element(page.getByText('That did not go through. Try again.')).toBeInTheDocument()
  })

  it('a decided card shows the decision and no buttons', async () => {
    render(ApprovalCard, { ...base, status: 'approved', ondecide: vi.fn() })
    await expect.element(page.getByText('Approved')).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Approve' }).elements()).toHaveLength(0)
  })

  it('someone who cannot decide sees that the owner decides', async () => {
    render(ApprovalCard, { ...base, canDecide: false, ondecide: vi.fn() })
    await expect.element(page.getByText('Waiting for the owner to decide.')).toBeInTheDocument()
    expect(page.getByRole('button', { name: 'Deny' }).elements()).toHaveLength(0)
  })
})
