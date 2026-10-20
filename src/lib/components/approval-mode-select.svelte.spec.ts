import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ApprovalModeSelect from './approval-mode-select.svelte'

describe('approval-mode-select.svelte', () => {
  it('shows the current mode and saves a change', async () => {
    const save = vi.fn(async (mode: string) => mode)
    render(ApprovalModeSelect, { mode: 'ask', save })
    const select = page.getByLabelText('Approvals')
    await expect.element(select).toHaveValue('ask')
    await select.selectOptions('Allow everything')
    expect(save).toHaveBeenCalledWith('allow_all')
    await expect.element(select).toHaveValue('allow_all')
  })

  it('a failed save keeps the previous selection and says so inline', async () => {
    const save = vi.fn(async () => {
      throw new Error('HTTP 403')
    })
    render(ApprovalModeSelect, { mode: 'reasonable', save })
    const select = page.getByLabelText('Approvals')
    await select.selectOptions('Ask every time')
    await expect.element(page.getByRole('alert')).toHaveTextContent('Could not change the approval mode.')
    await expect.element(select).toHaveValue('reasonable')
  })

  it('an unloadable mode is shown as unavailable, not as a default', async () => {
    render(ApprovalModeSelect, { mode: null, save: vi.fn() })
    await expect.element(page.getByText('Approval mode could not be loaded.')).toBeInTheDocument()
    expect(page.getByLabelText('Approvals').elements()).toHaveLength(0)
  })
})
