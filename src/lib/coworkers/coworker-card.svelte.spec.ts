import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import CoworkerCard from './coworker-card.svelte'

/**
 * Edit a co-worker (fc3c5174, "changes are not saved when Save is pressed"):
 * the edit form posts every field the tool takes, every manager in the order
 * it has them (the first is the primary), and a refused save shows its
 * sentence under the card instead of passing silently.
 */

const models = [
  { id: 'google/gemini-3.8-flash', family: 'Google', name: 'gemini-3.8-flash', note: 'Careful tool use.', recommended: false },
]
const seats = [
  { id: 'olga', name: 'Olga Owner', kind: 'human' as const },
  { id: 'ony', name: 'Ony', kind: 'human' as const },
  { id: 'mara', name: 'Mara', kind: 'coworker' as const },
]
const coworker = {
  id: 'mara',
  name: 'Mara',
  slug: 'mara',
  title: 'Marketing Manager',
  accountabilities: ['Pipeline'],
  lens: 'Cares about reach.',
  modelId: 'google/gemini-3.8-flash',
  enabled: true,
  dailyCapUsd: 2,
  // Primary manager Ony, second Olga: not the order the checkboxes are listed in.
  reportsToUserId: 'ony',
  reportsToUserIds: ['ony', 'olga'],
  image: '/avatars/coworkers/orbit.svg',
  accountableHuman: { id: 'olga', name: 'Olga Owner' },
}
const rhythms = { rhythms: [], targets: [] }

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

describe('coworker-card.svelte', () => {
  it('wish acdb941e: shows its AI usage of the period (tokens in/out and cost) with the AI-usage periods as links', async () => {
    render(CoworkerCard, {
      coworker,
      models,
      seats,
      rhythms,
      timeZone: 'Europe/Berlin',
      usage: { amounts: { costUsd: 0.5, calls: 4, promptTokens: 1500, completionTokens: 500, cachedTokens: 0 }, billing: null, period: '7' },
    })
    await expect.element(page.getByTestId('coworker-usage-tokens')).toHaveTextContent('2k tokens')
    await expect.element(page.getByTestId('coworker-usage')).toHaveTextContent('Last 7 days')
    await expect.element(page.getByTestId('coworker-usage-cost')).toHaveTextContent('$0.50')
    await expect.element(page.getByRole('link', { name: 'Last 30 days' })).toHaveAttribute('href', '?usage=30')
    await expect.element(page.getByRole('link', { name: 'Last 7 days' })).toHaveAttribute('aria-current', 'page')
  })

  it('Save posts the edited card with every manager, primary first, and the avatar', async () => {
    render(CoworkerCard, { coworker, models, seats, rhythms, timeZone: 'Europe/Berlin' })
    await page.getByTestId('coworker-edit').click()
    await userEvent.fill(page.getByTestId('coworker-mara-lens'), 'Cares about reach and tone.')
    await page.getByTestId('coworker-save').click()
    expect(submitted).toHaveLength(1)
    expect(submitted[0]!.action).toBe('?/update')
    expect(submitted[0]!.fields).toMatchObject({
      user_id: 'mara',
      name: 'Mara',
      lens: 'Cares about reach and tone.',
      reports_to_sent: '1',
      reports_to_user_ids: ['ony', 'olga'],
      avatar_sent: '1',
      avatar_preset: 'orbit',
    })
  })

  it('a refused save shows its sentence under the card', async () => {
    render(CoworkerCard, {
      coworker,
      models,
      seats,
      rhythms,
      timeZone: 'Europe/Berlin',
      form: { action: 'update', userId: 'mara', error: 'Mara cannot report to someone who reports to Mara.' },
    })
    await expect.element(page.getByTestId('coworker-feedback')).toHaveTextContent('Mara cannot report to someone who reports to Mara.')
  })

  it('on eigenInference (no models, modelId null): no model named, no picker, no model_id posted', async () => {
    render(CoworkerCard, { coworker: { ...coworker, modelId: null }, models: [], seats, rhythms, timeZone: 'Europe/Berlin' })
    await expect.element(page.getByText('Runs on eigenInference').first()).toBeVisible()
    expect(document.body.textContent).not.toContain('gemini')
    expect(document.body.textContent).not.toContain('Google')
    await page.getByTestId('coworker-edit').click()
    expect(document.querySelector('[data-testid="coworker-mara-model"]')).toBeNull()
    await page.getByTestId('coworker-save').click()
    expect(submitted[0]!.fields).not.toHaveProperty('model_id')
  })
})
