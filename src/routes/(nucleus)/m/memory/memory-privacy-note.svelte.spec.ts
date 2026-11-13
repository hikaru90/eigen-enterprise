import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MemoryPrivacyNote from './memory-privacy-note.svelte'

const note = () => page.getByRole('note', { name: 'Who can see your Memory' })

describe('MemoryPrivacyNote', () => {
  it('states who can read it, what the assistant and keys can do, what leaves the server, and delete', async () => {
    render(MemoryPrivacyNote, { analyticsSeesAi: false })
    await expect.element(note()).toBeVisible()
    await expect.element(note()).toHaveTextContent(/only you/i)
    await expect.element(note()).toHaveTextContent(/other members, admins and the owner can.t/i)
    await expect.element(note()).toHaveTextContent(/assistant doesn.t read it/i)
    await expect.element(note()).toHaveTextContent(/API key with MCP access/i)
    await expect.element(note()).toHaveTextContent(/archive.*never delete/i)
    await expect.element(note()).toHaveTextContent(/AI provider/i)
    await expect.element(note()).toHaveTextContent(/voice notes are transcribed by OpenRouter/i)
    await expect.element(note()).toHaveTextContent(/direct access to the server/i)
    await expect.element(note()).toHaveTextContent(/delete removes a thought for good/i)
    await expect.element(note()).toHaveTextContent(/backups/i)
    await expect
      .element(note())
      .toHaveTextContent(/server.s logs and your AI usage log note .* never what you wrote/i)
    await expect.element(note()).not.toHaveTextContent(/PostHog/i)
    await expect
      .element(page.getByRole('link', { name: /delete everything/i }))
      .toHaveAttribute('href', '/m/memory/settings#your-data')
  })

  it('says product analytics sees how AI requests went, never their text — only when this server uses it', async () => {
    render(MemoryPrivacyNote, { analyticsSeesAi: true })
    await expect.element(note()).toHaveTextContent(/product analytics \(PostHog\)/i)
    await expect.element(note()).toHaveTextContent(/never your Memory text/i)
    await expect.element(note()).not.toHaveTextContent(/including your Memory text/i)
  })

  it('can be dismissed', async () => {
    render(MemoryPrivacyNote, { analyticsSeesAi: false })
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect.element(note()).not.toBeInTheDocument()
  })
})
