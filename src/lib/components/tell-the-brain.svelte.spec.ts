import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { AssistantController } from '$lib/components/assistant/assistant-controller.svelte'
import Harness from './tell-the-brain-test-harness.svelte'

const controller = () =>
  new AssistantController({
    fetch: async () => new Response('{}', { status: 500 }),
    speak: () => {},
    cancelSpeak: () => {},
    storage: () => localStorage,
    viewportWidth: () => 1280,
  })

describe('tell-the-brain.svelte (the one door)', () => {
  it('points to the Ask bar, and its button puts the cursor there', async () => {
    const assistant = controller()
    const bar = document.createElement('input')
    document.body.append(bar)
    assistant.barInput = bar
    try {
      render(Harness, { assistant })
      await expect
        .element(page.getByTestId('tell-the-brain'))
        .toHaveTextContent('To add something, tell the company brain in the Ask bar — it files it.')
      await page.getByTestId('tell-the-brain-open').click()
      expect(document.activeElement).toBe(bar)
    } finally {
      bar.remove()
    }
  })

  it('with the Assistant switched off: says there is no Ask bar instead of pointing at nothing', async () => {
    render(Harness, { assistant: null })
    await expect.element(page.getByTestId('tell-the-brain-off')).toHaveTextContent(/Assistant is switched off/)
    await expect.element(page.getByTestId('tell-the-brain-open')).not.toBeInTheDocument()
  })
})
