import type { AssistantController } from './assistant-controller.svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import type { RunSummary } from '$lib/agent-runs/feed'
import AssistantHistory from './assistant-history.svelte'

/**
 * Renaming a conversation in the History tab (Contribute 495e40bb): the
 * pencil opens an inline field, Enter saves through PATCH, Esc cancels, and
 * only the viewer's own conversations offer it.
 */

const mine: RunSummary = {
  id: 7,
  conversationKey: 'orchestrator:s-1',
  agentId: 'orchestrator',
  title: 'Kannst du mir bitte helfen, eine Website für meine Bäckerei',
  renamable: true,
  createdAt: '2026-11-03T10:00:00.000Z',
  updatedAt: '2026-11-04T09:30:00.000Z',
}
const theirs: RunSummary = {
  ...mine,
  id: 8,
  conversationKey: 'orchestrator:s-2',
  title: 'Chat with Ada Park',
  renamable: false,
}

type Patch = { url: string; body: unknown }
let patches: Patch[]
let patchResponse: () => Response

function controller(): AssistantController {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/agent/runs') return Response.json({ runs: [mine, theirs] })
    if (init?.method === 'PATCH') {
      patches.push({ url, body: JSON.parse(String(init.body)) })
      return patchResponse()
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return { fetch, newConversation: vi.fn() } as unknown as AssistantController
}

const titles = () => page.getByTestId('assistant-history-title')

describe('assistant-history.svelte rename', () => {
  beforeEach(() => {
    patches = []
    patchResponse = () => Response.json({ run: { ...mine, title: 'Bäckerei-Website' } })
  })

  it('offers rename only on the viewer\'s own conversations', async () => {
    render(AssistantHistory, { assistant: controller() })
    await expect.element(titles().nth(1)).toHaveTextContent('Chat with Ada Park')
    expect(page.getByTestId('assistant-history-rename').elements()).toHaveLength(1)
  })

  it('pencil → field with the current name, Enter saves the trimmed name', async () => {
    render(AssistantHistory, { assistant: controller() })
    await page.getByRole('button', { name: 'Rename conversation' }).click()
    const input = page.getByRole('textbox', { name: 'Conversation name' })
    await expect.element(input).toHaveValue(mine.title)
    await expect.element(input).toHaveFocus()
    await input.fill('  Bäckerei-Website  ')
    await userEvent.keyboard('{Enter}')
    await expect.element(titles().first()).toHaveTextContent('Bäckerei-Website')
    expect(patches).toEqual([{ url: '/api/agent/runs/7', body: { title: 'Bäckerei-Website' } }])
    expect(page.getByRole('textbox').elements()).toHaveLength(0)
  })

  it('Esc cancels without saving', async () => {
    render(AssistantHistory, { assistant: controller() })
    await page.getByRole('button', { name: 'Rename conversation' }).click()
    await page.getByRole('textbox', { name: 'Conversation name' }).fill('Something else')
    await userEvent.keyboard('{Escape}')
    await expect.element(titles().first()).toHaveTextContent(mine.title)
    expect(page.getByRole('textbox').elements()).toHaveLength(0)
    expect(patches).toEqual([])
  })

  it('refuses an empty name in place, without a request', async () => {
    render(AssistantHistory, { assistant: controller() })
    await page.getByRole('button', { name: 'Rename conversation' }).click()
    await page.getByRole('textbox', { name: 'Conversation name' }).fill('   ')
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('alert')).toHaveTextContent('A conversation needs a name.')
    expect(patches).toEqual([])
  })

  it('keeps the field open and says why when the server refuses', async () => {
    patchResponse = () =>
      Response.json(
        { error: 'Only the member who had this conversation can rename it.' },
        { status: 403 },
      )
    render(AssistantHistory, { assistant: controller() })
    await page.getByRole('button', { name: 'Rename conversation' }).click()
    await page.getByRole('textbox', { name: 'Conversation name' }).fill('Mine')
    await userEvent.keyboard('{Enter}')
    await expect
      .element(page.getByRole('alert'))
      .toHaveTextContent('Only the member who had this conversation can rename it.')
    await expect.element(page.getByRole('textbox', { name: 'Conversation name' })).toHaveValue('Mine')
  })
})
