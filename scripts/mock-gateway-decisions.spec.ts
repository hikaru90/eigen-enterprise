import { describe, expect, it } from 'vitest'
import { MOCK_DECISION_COST_USD, mockDecision } from './mock-gateway-decisions.mjs'

const question = (criteria: Record<string, string>) => ({ type: 'choice', instructions: 'Which?', criteria })

describe('mockDecision (OpenRouter Decisions API shape)', () => {
  it('answers every question with its first choice, certain, with the provider-reported cost', () => {
    const out = mockDecision({
      model: 'typesafe/jev-1.13',
      state: 'Some text',
      questions: { a: question({ yes: 'y', no: 'n' }), b: question({ low: 'l', high: 'h' }) },
    })
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({
      model: 'typesafe/jev-1.13-mock',
      answers: {
        a: { type: 'choice', choice: 'yes', probabilities: { yes: 1, no: 0 }, confidence: 1 },
        b: { type: 'choice', choice: 'low', probabilities: { low: 1, high: 0 }, confidence: 1 },
      },
      usage: { input_tokens: expect.any(Number), output_tokens: expect.any(Number), cost: MOCK_DECISION_COST_USD },
    })
  })

  it('a [mock-decide:<question>=<choice>@<confidence>] marker in the state picks the answer', () => {
    const out = mockDecision({
      model: 'typesafe/jev-1.13',
      state: 'Mail text [mock-decide:a=no@0.4]',
      questions: { a: question({ yes: 'y', no: 'n', maybe: 'm' }) },
    })
    expect(out.body.answers.a).toEqual({
      type: 'choice',
      choice: 'no',
      probabilities: { yes: 0.3, no: 0.4, maybe: 0.3 },
      confidence: 0.4,
    })
  })

  it('a marker may name a choice outside the closed set (to test that the gateway refuses it)', () => {
    const out = mockDecision({
      model: 'typesafe/jev-1.13',
      state: '[mock-decide:a=perhaps@0.9]',
      questions: { a: question({ yes: 'y', no: 'n' }) },
    })
    expect(out.body.answers.a.choice).toBe('perhaps')
  })

  it('refuses a request without questions, or a question that is not a choice, like the API (400)', () => {
    expect(mockDecision({ model: 'm', state: 's', questions: {} }).status).toBe(400)
    expect(mockDecision({ model: 'm', state: 's', questions: { q: { type: 'boolean', instructions: 'x' } } }).status).toBe(400)
    expect(mockDecision({ model: 'm', questions: { q: question({ a: 'a' }) } }).status).toBe(400)
  })
})
