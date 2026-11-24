import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import CoworkerCreateForm from './coworker-create-form.svelte'

/**
 * Create from a template (plan/phase-ai-coworkers.md C5): picking a template
 * prefills name, title, accountabilities, lens, model and daily cap (each
 * editable); the model picker lists the pool's chat models with their family;
 * the form posts the tool's fields to ?/create.
 */

const templates = [
  {
    id: 'marketing-manager',
    title: 'Marketing Manager',
    accountabilities: ['Pipeline from content', 'Launch plans'],
    lens: 'You care about reach.',
    suggestedModelId: 'anthropic/claude-sonnet-5.5',
    suggestedDailyCapUsd: 2,
  },
  {
    id: 'designer',
    title: 'Designer',
    accountabilities: ['Look and feel'],
    lens: 'Taste first.',
    suggestedModelId: 'qwen/qwen3.8-flash',
    suggestedDailyCapUsd: 1,
  },
]
const models = [
  { id: '~deepseek/deepseek-flash-latest', family: 'DeepSeek', name: 'deepseek-flash-latest', note: 'The default.', recommended: true },
  { id: 'anthropic/claude-sonnet-5.5', family: 'Anthropic', name: 'claude-sonnet-5.5', note: 'Careful tool use.', recommended: false },
  { id: 'qwen/qwen3.8-flash', family: 'Qwen', name: 'qwen3.8-flash', note: 'The cheap seat.', recommended: false },
]
const seats = [
  { id: 'olga', name: 'Olga Owner', kind: 'human' as const },
  { id: 'mara', name: 'Mara', kind: 'coworker' as const },
]

type Submitted = { action: string; fields: Record<string, string | string[]> }
let submitted: Submitted[] = []
function catchSubmits(event: SubmitEvent) {
  event.preventDefault()
  const form = event.target as HTMLFormElement
  const fd = new FormData(form, event.submitter)
  const fields: Record<string, string | string[]> = {}
  for (const k of new Set(fd.keys())) {
    const all = fd.getAll(k).map(String)
    fields[k] = k === 'reports_to_user_ids' ? all : all.length > 1 ? all : all[0]!
  }
  submitted.push({ action: form.getAttribute('action') ?? '', fields })
}
beforeEach(() => {
  submitted = []
  document.addEventListener('submit', catchSubmits, true)
})
afterEach(() => document.removeEventListener('submit', catchSubmits, true))

const value = (testid: string) => (page.getByTestId(testid).element() as HTMLInputElement).value

describe('coworker-create-form.svelte', () => {
  it('a template fills the role card, and the model picker names each model with its family', async () => {
    render(CoworkerCreateForm, { templates, models, seats })
    await page.getByRole('radio', { name: /Marketing Manager/ }).click()
    expect(value('new-coworker-name')).toBe('Marketing Manager')
    expect(value('new-coworker-title')).toBe('Marketing Manager')
    expect(value('new-coworker-accountabilities')).toBe('Pipeline from content\nLaunch plans')
    expect(value('new-coworker-lens')).toBe('You care about reach.')
    expect(value('new-coworker-model')).toBe('anthropic/claude-sonnet-5.5')
    expect(value('new-coworker-cap')).toBe('2')
    const options = [...(page.getByTestId('new-coworker-model').element() as HTMLSelectElement).options].map((o) => o.textContent)
    expect(options).toEqual(['DeepSeek · deepseek-flash-latest (recommended)', 'Anthropic · claude-sonnet-5.5', 'Qwen · qwen3.8-flash'])
    await expect.element(page.getByTestId('new-coworker-model-note')).toHaveTextContent('Careful tool use.')
  })

  it('switching template replaces the card but keeps who it reports to and the picked avatar', async () => {
    render(CoworkerCreateForm, { templates, models, seats })
    await page.getByRole('radio', { name: /Marketing Manager/ }).click()
    await page.getByTestId('new-coworker-manager').getByRole('checkbox', { name: 'Olga Owner' }).click()
    await page.getByTestId('new-coworker-avatar-preset-prism').click()
    await page.getByRole('radio', { name: /Designer/ }).click()
    expect(value('new-coworker-title')).toBe('Designer')
    expect(value('new-coworker-model')).toBe('qwen/qwen3.8-flash')
    await expect.element(page.getByTestId('new-coworker-manager').getByRole('checkbox', { name: 'Olga Owner' })).toBeChecked()
    await expect.element(page.getByTestId('new-coworker-avatar-preset-prism')).toHaveAttribute('aria-pressed', 'true')
  })

  it('posts the edited card, multi-manager checkboxes, and avatar preset with the template to ?/create', async () => {
    render(CoworkerCreateForm, { templates, models, seats })
    await page.getByRole('radio', { name: /Designer/ }).click()
    await userEvent.fill(page.getByLabelText('Name', { exact: true }), 'Dana')
    await userEvent.selectOptions(page.getByLabelText('Model', { exact: true }), 'Anthropic · claude-sonnet-5.5')
    await page.getByTestId('new-coworker-manager').getByRole('checkbox', { name: 'Olga Owner' }).click()
    await page.getByTestId('new-coworker-manager').getByRole('checkbox', { name: 'Mara (AI)' }).click()
    await page.getByTestId('new-coworker-avatar-preset-orbit').click()
    await page.getByTestId('coworker-create').click()
    expect(submitted).toEqual([
      {
        action: '?/create',
        fields: {
          template_id: 'designer',
          name: 'Dana',
          title: 'Designer',
          accountabilities: 'Look and feel',
          lens: 'Taste first.',
          model_id: 'anthropic/claude-sonnet-5.5',
          reports_to_sent: '1',
          reports_to_user_ids: ['olga', 'mara'],
          daily_cap_usd: '1',
          avatar_sent: '1',
          avatar_preset: 'orbit',
          avatar_sha256: '',
        },
      },
    ])
  })

  it('blank is the start: nothing prefilled and the browser asks for the required fields', async () => {
    render(CoworkerCreateForm, { templates, models, seats })
    await expect.element(page.getByTestId('coworker-template-blank')).toBeChecked()
    expect(value('new-coworker-title')).toBe('')
    await page.getByTestId('coworker-create').click()
    expect(submitted).toEqual([])
  })

  it('says when the creation waits for approval', async () => {
    render(CoworkerCreateForm, { templates, models, seats, feedback: { kind: 'waiting' } })
    await expect.element(page.getByTestId('coworker-create-feedback')).toHaveTextContent('Waiting for approval')
  })
})
