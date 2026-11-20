import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import AiPage from './+page.svelte'

vi.mock('$app/forms', () => ({
  enhance: () => ({ destroy: () => undefined }),
  applyAction: vi.fn(),
  deserialize: vi.fn(),
}))

/**
 * Settings → AI provider (CB1): the "Use eigenInference" switch, the role slots as dropdowns
 * from the curated pool, the install's fixed embedding model, and the company's own keys under
 * Advanced. Real Svelte in a real browser; form posts are caught at the submit event.
 */

type Submitted = { action: string; fields: Record<string, string> }
let submitted: Submitted[] = []

function catchSubmits(event: SubmitEvent) {
  event.preventDefault()
  const form = event.target as HTMLFormElement
  const fields: Record<string, string> = {}
  for (const [k, v] of new FormData(form, event.submitter).entries()) fields[k] = String(v)
  submitted.push({ action: form.getAttribute('action') ?? '', fields })
}

beforeEach(() => {
  submitted = []
  document.addEventListener('submit', catchSubmits, true)
})

afterEach(() => {
  document.removeEventListener('submit', catchSubmits, true)
})

const option = (id: string, recommended = false) => ({ id, note: `${id} note`, recommended })

function data(over: Record<string, unknown> = {}, ai: Record<string, unknown> = {}) {
  return {
    isAdmin: true,
    canManageAi: true,
    isOwner: true,
    byokConfigured: false,
    activeProvider: 'eurouter',
    speech: { dictation: { ready: true }, models: [] },
    providers: {
      eurouter: { configured: false, baseUrl: '', apiKey: '', ruleChat: '', ruleEmbedding: '' },
      openrouter: { configured: false, baseUrl: '', apiKey: '' },
    },
    ai: {
      useEigenInference: true,
      eigenInferenceAvailable: true,
      embeddingModel: 'qwen/qwen3-embedding-8b',
      slots: [
        {
          slot: 'chat',
          model: '~deepseek/deepseek-flash-latest',
          pick: null,
          options: [option('~deepseek/deepseek-flash-latest', true), option('openai/gpt-5-mini')],
        },
        { slot: 'stt', model: 'qwen/qwen3-asr-1.7b', pick: null, options: [option('qwen/qwen3-asr-1.7b', true)] },
        {
          slot: 'tts',
          model: 'qwen/qwen-audio-3.0-tts-flash',
          pick: null,
          options: [option('qwen/qwen-audio-3.0-tts-flash', true)],
        },
        { slot: 'decision', model: 'typesafe/jev-1.13', pick: null, options: [option('typesafe/jev-1.13', true)] },
      ],
      ...ai,
    },
    ...over,
  }
}

const props = (d: ReturnType<typeof data>, form: unknown = null) => ({ data: d, form, params: {} }) as never

describe('Settings → AI provider', () => {
  it('shows the switch on and one dropdown per role slot, each set to the model the company runs on', async () => {
    render(AiPage, props(data()))

    const toggle = page.getByRole('switch', { name: 'Use eigenInference' })
    await expect.element(toggle).toHaveAttribute('aria-checked', 'true')
    await expect.element(page.getByLabelText('Chat', { exact: true })).toHaveValue('~deepseek/deepseek-flash-latest')
    await expect.element(page.getByLabelText('Speech to text')).toHaveValue('qwen/qwen3-asr-1.7b')
    await expect.element(page.getByLabelText('Text to speech')).toHaveValue('qwen/qwen-audio-3.0-tts-flash')
    await expect.element(page.getByLabelText('Decisions')).toHaveValue('typesafe/jev-1.13')
    await expect.element(page.getByRole('option', { name: '~deepseek/deepseek-flash-latest (recommended)' })).toBeInTheDocument()
  })

  it('embedding is not a dropdown: the install’s model is shown as fixed', async () => {
    render(AiPage, props(data()))
    const embedding = page.getByTestId('embedding-slot')
    await expect.element(embedding).toHaveTextContent('qwen/qwen3-embedding-8b')
    await expect.element(embedding).toHaveTextContent('Fixed for this install')
    expect(document.querySelectorAll('[data-testid="embedding-slot"] select')).toHaveLength(0)
  })

  it('the switch posts the opposite of its state', async () => {
    render(AiPage, props(data()))
    await userEvent.click(page.getByRole('switch', { name: 'Use eigenInference' }))
    expect(submitted).toEqual([{ action: '?/setEigenInference', fields: { on: 'false' } }])
  })

  it('picking a model in a dropdown saves that slot right away', async () => {
    render(AiPage, props(data()))
    await userEvent.selectOptions(page.getByLabelText('Chat', { exact: true }), 'openai/gpt-5-mini')
    expect(submitted).toEqual([{ action: '?/setSlot', fields: { slot: 'chat', model: 'openai/gpt-5-mini' } }])
  })

  it('says so when eigenInference is on but this server has no eigenInference yet', async () => {
    render(AiPage, props(data({}, { eigenInferenceAvailable: false })))
    await expect.element(page.getByTestId('eigen-inference-missing')).toBeInTheDocument()
  })

  it('with eigenInference off, Advanced is open and the owner manages the company keys there', async () => {
    render(AiPage, props(data({}, { useEigenInference: false })))
    await expect.element(page.getByRole('switch', { name: 'Use eigenInference' })).toHaveAttribute('aria-checked', 'false')
    await expect.element(page.getByTestId('llm-providers')).toBeVisible()
    await expect.element(page.getByRole('link', { name: /OpenRouter/ })).toHaveAttribute('href', '/settings/llm/byok/openrouter')
  })

  it('Advanced has no free-text model fields: only EUrouter keeps its routing rules (CB1)', async () => {
    render(AiPage, props(data({}, { useEigenInference: false })))
    await expect.element(page.getByTestId('eurouter-rules')).toBeVisible()
    await expect.element(page.getByLabelText('Chat routing rule')).toBeVisible()
    expect(document.querySelector('input[name="modelChat"]')).toBeNull()
    expect(document.querySelector('input[name="modelEmbedding"]')).toBeNull()
  })

  it('a member sees the choices but cannot change them, and no keys', async () => {
    render(AiPage, props(data({ isAdmin: false, canManageAi: false, isOwner: false }, { useEigenInference: false })))
    await expect.element(page.getByRole('switch', { name: 'Use eigenInference' })).toBeDisabled()
    await expect.element(page.getByLabelText('Chat', { exact: true })).toBeDisabled()
    await expect.element(page.getByTestId('advanced-owner-only')).toBeVisible()
    expect(document.querySelector('[data-testid="llm-providers"]')).toBeNull()
  })

  it('shows what the server said after a save', async () => {
    render(AiPage, props(data(), { slotMessage: 'Saved: openai/gpt-5-mini.' }))
    await expect.element(page.getByText('Saved: openai/gpt-5-mini.')).toBeInTheDocument()
  })
})
