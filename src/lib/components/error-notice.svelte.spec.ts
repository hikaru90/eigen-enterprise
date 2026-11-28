import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ErrorNotice from './error-notice.svelte'

function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard)
}

const copyButton = () => page.getByRole('button', { name: 'Copy agent instructions' })

afterEach(() => vi.restoreAllMocks())

describe('ErrorNotice: a sentence for the person, instructions for an agent', () => {
  it('announces the plain sentence as an alert and always offers the copy button', async () => {
    render(ErrorNotice, { error: 'Check the domain: enter just the host name.' })
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Check the domain: enter just the host name.')
    await expect.element(copyButton()).toBeVisible()
  })

  it('wish 714726fe: says what the copy is for and where to paste it, before and after copying', async () => {
    stubClipboard(async () => {})
    render(ErrorNotice, { error: 'Something broke.' })
    await expect
      .element(copyButton())
      .toHaveAccessibleDescription('Copies a report of this error. Paste it into the assistant (or your coding agent) and send it to get it fixed.')
    await copyButton().click()
    await expect
      .element(page.getByRole('status'))
      .toHaveTextContent('Copied. Now paste it into the assistant (or your coding agent) and send it.')
  })

  it('shows an optional title above the sentence', async () => {
    render(ErrorNotice, { error: 'Build failed at npm ci.', title: 'The last deploy failed' })
    await expect.element(page.getByRole('alert')).toHaveTextContent('The last deploy failed')
  })

  it('copies the server report as agent instructions: tool, code, redacted input, steps', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    render(ErrorNotice, {
      error: 'Check the domains.',
      agent: {
        attempted: 'Deploying an app',
        tool: 'website.app_deploy',
        code: 'invalid_input',
        input: { name: 'site', hosts: ['https://x/'] },
        details: { issues: [{ path: 'hosts.0', message: 'Invalid' }] },
        nextSteps: ['Compare the input with the tool schema.'],
      },
    })
    await copyButton().click()
    expect(writeText).toHaveBeenCalledTimes(1)
    const text = writeText.mock.calls[0]![0] as string
    expect(text).toContain('The person saw: "Check the domains."')
    expect(text).toContain('Kernel tool: website.app_deploy')
    expect(text).toContain('Error code: invalid_input')
    expect(text).toContain('"hosts.0"')
    expect(text).toContain('1. Compare the input with the tool schema.')
    expect(text).toContain(`Page: ${location.pathname}`)
    await expect.element(page.getByRole('button', { name: 'Copied' })).toBeVisible()
  })

  it('without a server report still copies what was attempted, where and when', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    render(ErrorNotice, {
      error: 'The progress could not be loaded.',
      attempted: 'Following a deploy',
    })
    await copyButton().click()
    const text = writeText.mock.calls[0]![0] as string
    expect(text).toContain('Attempted: Following a deploy')
    expect(text).toMatch(/Time: \d{4}-\d\d-\d\dT/)
  })

  it('when the browser blocks the clipboard, shows the instructions to copy by hand', async () => {
    stubClipboard(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    render(ErrorNotice, { error: 'Something went wrong.', attempted: 'Saving' })
    await copyButton().click()
    await expect.element(page.getByText('The browser blocked copying.')).toBeVisible()
    await expect
      .element(page.getByRole('textbox', { name: 'Agent instructions' }))
      .toHaveValue(expect.stringContaining('Attempted: Saving'))
  })
})
