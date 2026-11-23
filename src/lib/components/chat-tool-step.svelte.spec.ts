import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ChatToolStep from './chat-tool-step.svelte'

describe('chat-tool-step.svelte', () => {
  it('names the tool in words with its state; opened, it shows the tool, input and result', async () => {
    render(ChatToolStep, {
      tool: 'memory.capture_thought',
      status: 'done',
      inputSummary: 'raw: Call Acme on Monday',
      resultSummary: 'id: t-1 · status: saved',
    })
    const step = page.getByTestId('tool-step')
    await expect.element(step).toHaveAttribute('data-status', 'done')
    await expect.element(page.getByTestId('tool-step-title')).toHaveTextContent('Capture thought')
    await expect.element(step).toHaveTextContent(/· Memory/)
    await expect.element(page.getByTestId('tool-step-state')).toHaveTextContent('Done')
    await expect.element(page.getByTestId('tool-step-details')).not.toBeVisible()
    await page.getByText('Capture thought').click()
    await expect.element(page.getByTestId('tool-step-details')).toBeVisible()
    await expect.element(page.getByTestId('tool-step-details')).toHaveTextContent(/memory\.capture_thought/)
    await expect.element(page.getByTestId('tool-step-result')).toHaveTextContent('id: t-1 · status: saved')
  })

  it('a failed step says so and shows the failure', async () => {
    render(ChatToolStep, { tool: 'email.send_mail', status: 'failed', resultSummary: 'to is required' })
    await expect.element(page.getByTestId('tool-step-state')).toHaveTextContent('Failed')
    await expect.element(page.getByTestId('tool-step-result')).toHaveTextContent('to is required')
  })

  it('a running step spins and has no result yet; a stopped one says it ended early', async () => {
    render(ChatToolStep, { tool: 'drive.list', status: 'running' })
    await expect.element(page.getByTestId('tool-step-state')).toHaveTextContent('Running')
    await expect.element(page.getByTestId('tool-step-result')).toHaveTextContent('Still running…')
    render(ChatToolStep, { tool: 'drive.list', status: 'stopped', testid: 'stopped' })
    await expect.element(page.getByTestId('stopped-result')).toHaveTextContent('The reply ended before this tool did.')
  })
})
