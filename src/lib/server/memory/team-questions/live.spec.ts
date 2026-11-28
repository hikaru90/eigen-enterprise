import { describe, expect, it } from 'vitest'
import { answerThoughtText } from './live'

describe('answer → brain knowledge', () => {
  it('keeps the question and the answer together in one thought', () => {
    expect(answerThoughtText('Wie buchen wir Reisekosten ab?', 'Über das Spesenformular.')).toBe(
      'Team question: Wie buchen wir Reisekosten ab?\nAnswer: Über das Spesenformular.',
    )
  })
})
