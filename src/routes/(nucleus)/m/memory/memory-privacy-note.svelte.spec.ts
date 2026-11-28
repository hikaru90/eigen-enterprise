import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import MemoryPrivacyNote from './memory-privacy-note.svelte'

const note = () => page.getByRole('region', { name: 'Who can see your Memory' })

describe('MemoryPrivacyNote', () => {
  it('states who can read it (shared by default, Private = yours alone), what the assistant and keys can do, what leaves the server, and delete', async () => {
    render(MemoryPrivacyNote)
    await expect.element(note()).toBeVisible()
    await expect
      .element(note())
      .toHaveTextContent(/projects and notes are shared with everyone in the company/i)
    await expect.element(note()).toHaveTextContent(/only you change them/i)
    await expect
      .element(note())
      .toHaveTextContent(/private and only you can see it: no admin, not even the owner/i)
    await expect
      .element(note())
      .toHaveTextContent(
        /your thoughts, what you capture and tasks outside a shared project are yours alone/i,
      )
    await expect.element(note()).toHaveTextContent(/company brain reads it only as you/i)
    await expect
      .element(note())
      .toHaveTextContent(
        /never their private things; a colleague.s question reaches only what you share/i,
      )
    await expect.element(note()).toHaveTextContent(/make things private for you, never share them/i)
    await expect
      .element(note())
      .toHaveTextContent(/when you ask, it adds thoughts and notes to your Memory/i)
    await expect.element(note()).toHaveTextContent(/changes only the notes it wrote/i)
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


})
