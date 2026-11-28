import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }))

import type { TeamQuestionView } from '$lib/server/memory/team-questions/service'
import QuestionsCard from './dashboard-questions-card.svelte'

const question = (id: string, text: string): TeamQuestionView => ({
  id,
  text,
  tags: [],
  audience: { kind: 'company', groups: [], people: [] },
  status: 'open',
  createdVia: 'person',
  createdAt: '2026-11-25T09:00:00.000Z',
  closedAt: null,
  author: { id: 'ony', name: 'Ony' },
  answers: [],
  mine: false,
  answeredByMe: false,
  forMe: true,
})

describe('dashboard questions card', () => {
  it('lists the questions asked of me, each with an answer field posting to Memory › Questions and an Open link', async () => {
    render(QuestionsCard, { questions: [question('q1', 'Who has the van key?'), question('q2', 'Demo Friday?')] })
    await expect.element(page.getByText('Who has the van key?')).toBeVisible()
    await expect.element(page.getByText('Demo Friday?')).toBeVisible()
    const forms = page.getByTestId('dashboard-question-answer').all()
    expect(forms).toHaveLength(2)
    const form = forms[0]!.element() as HTMLFormElement
    expect(form.getAttribute('action')).toBe('/m/memory/questions?/answer')
    expect((form.querySelector('input[name="question_id"]') as HTMLInputElement).value).toBe('q1')
    expect(page.getByTestId('dashboard-question-open').first().element().getAttribute('href')).toBe('/m/memory/questions')
  })

  it('renders nothing when no question is open for me', async () => {
    render(QuestionsCard, { questions: [] })
    await expect.element(page.getByTestId('dashboard-questions')).not.toBeInTheDocument()
  })
})
