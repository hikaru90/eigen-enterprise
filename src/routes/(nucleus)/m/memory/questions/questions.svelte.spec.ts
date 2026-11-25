import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { setLocale } from '$lib/paraglide/runtime'
import type { TeamQuestionView } from '$lib/server/memory/team-questions/service'
import Questions from './questions.svelte'

const question = (over: Partial<TeamQuestionView> = {}): TeamQuestionView => ({
  id: 'q1',
  text: 'Who owns the Acme renewal?',
  tags: ['sales', 'acme'],
  audience: {
    kind: 'chosen',
    groups: [{ id: 'g-sales', name: 'Sales' }],
    people: [{ id: 'sam', name: 'Sam' }],
  },
  status: 'open',
  createdVia: 'person',
  createdAt: '2026-11-25T09:00:00.000Z',
  closedAt: null,
  author: { id: 'ony', name: 'Ony' },
  answers: [],
  mine: false,
  answeredByMe: false,
  forMe: true,
  ...over,
})

const audience = {
  groups: [{ id: 'g-sales', name: 'Sales' }],
  people: [{ id: 'sam', name: 'Sam' }],
}
const tags = [
  { tag: 'sales', count: 2 },
  { tag: 'acme', count: 1 },
]
const openFilter = { tag: null, status: 'open' as const, forMe: false }

describe('Memory › Questions', () => {
  afterEach(() => setLocale('en', { reload: false }))

  it('one card per question: the line, who asked whom, answers count, tags; an answer field while open', async () => {
    render(Questions, {
      questions: [
        question(),
        question({
          id: 'q2',
          text: 'Wo liegt das Logo?',
          tags: [],
          audience: { kind: 'company', groups: [], people: [] },
          author: { id: 'me', name: 'Me' },
          mine: true,
          forMe: false,
          status: 'closed',
          closedAt: '2026-11-25T10:00:00.000Z',
          answers: [
            {
              id: 'a1',
              author: { id: 'kim', name: 'Kim' },
              text: 'In Drive › Brand.',
              createdVia: 'person',
              at: '2026-11-25T09:30:00.000Z',
            },
          ],
        }),
      ],
      tags,
      audience,
      filter: { ...openFilter, status: 'all' },
    })
    const [first, second] = page.getByTestId('question').all()
    await expect
      .element(first.getByTestId('question-title'))
      .toHaveTextContent('Who owns the Acme renewal?')
    await expect
      .element(first.getByTestId('question-meta'))
      .toHaveTextContent('From Ony to Sales, Sam · 0 answers')
    await expect.element(first.getByTestId('question-tags-shown')).toHaveTextContent('#sales#acme')
    await expect.element(first.getByTestId('question-answer-text')).toBeInTheDocument()
    await expect.element(first.getByTestId('question-close')).not.toBeInTheDocument()
    await expect
      .element(second.getByTestId('question-meta'))
      .toHaveTextContent('From you to the whole company · 1 answer · Closed')
    await expect
      .element(second.getByTestId('question-answers'))
      .toHaveTextContent('Kim In Drive › Brand.')
    await expect.element(second.getByTestId('question-answer-form')).not.toBeInTheDocument()
  })

  it('the asker closes an open question of theirs', async () => {
    render(Questions, {
      questions: [question({ mine: true, forMe: false })],
      tags,
      audience,
      filter: openFilter,
    })
    await expect.element(page.getByTestId('question-close')).toBeInTheDocument()
  })

  it('asks the whole company by default; chosen shows the groups and people to pick; a used tag adds itself', async () => {
    render(Questions, { questions: [], tags, audience, filter: openFilter })
    await expect.element(page.getByTestId('question-audience-company')).toBeChecked()
    await expect.element(page.getByTestId('question-audience-picker')).not.toBeInTheDocument()
    await page.getByText('Chosen groups and people').click()
    await expect
      .element(page.getByTestId('question-audience-picker'))
      .toHaveTextContent(/Groups\s*Sales/)
    await expect.element(page.getByTestId('question-pick-sam')).toBeInTheDocument()
    await page.getByTestId('question-tag-suggestions').getByText('#sales').click()
    await page.getByTestId('question-tag-suggestions').getByText('#acme').click()
    await expect.element(page.getByTestId('question-tags')).toHaveValue('sales, acme')
    await expect
      .element(page.getByTestId('questions-empty'))
      .toHaveTextContent('No questions here yet.')
  })

  it('filters are links: status, open for me, one tag (keeping the status)', async () => {
    render(Questions, {
      questions: [],
      tags,
      audience,
      filter: { tag: null, status: 'open', forMe: true },
    })
    await expect
      .element(page.getByTestId('questions-filter-for-me'))
      .toHaveAttribute('aria-current', 'page')
    await expect
      .element(page.getByTestId('questions-filter-closed'))
      .toHaveAttribute('href', '/m/memory/questions?status=closed')
    await expect
      .element(page.getByTestId('questions-filter-open'))
      .toHaveAttribute('href', '/m/memory/questions')
    await expect
      .element(page.getByTestId('questions-tag-acme'))
      .toHaveAttribute('href', '/m/memory/questions?for=me&tag=acme')
    await expect
      .element(page.getByTestId('questions-empty'))
      .toHaveTextContent('No question waits for your answer.')
  })

  it('speaks German', async () => {
    setLocale('de', { reload: false })
    render(Questions, { questions: [question()], tags, audience, filter: openFilter })
    await expect.element(page.getByTestId('question-new')).toHaveTextContent(/Frage ans Team/)
    await expect
      .element(page.getByTestId('question-meta'))
      .toHaveTextContent('Von Ony an Sales, Sam · 0 Antworten')
    await expect
      .element(page.getByTestId('questions-filter-for-me'))
      .toHaveTextContent('Offen für mich')
    await expect.element(page.getByTestId('question-answer')).toHaveTextContent('Antworten')
  })
})
