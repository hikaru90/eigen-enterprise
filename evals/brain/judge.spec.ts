import { describe, expect, it } from 'vitest'
import { JUDGE_DECISIONS, judgeMessages, parseJudgeDecision } from './judge'

describe('the closed-set judge (moves to Jev in CB2)', () => {
  it('each decision kind is a closed set of named choices', () => {
    expect(JUDGE_DECISIONS.knows.fields).toEqual({ verdict: ['correct', 'partial', 'incorrect', 'no_answer'], cited: ['yes', 'no'] })
    expect(JUDGE_DECISIONS.judgment.fields.statement).toEqual(['observation_only', 'contains_judgment', 'no_statement_about_person'])
  })

  it('accepts exactly the schema: every field, one of its choices', () => {
    expect(parseJudgeDecision('leak', '{"discloses":"no"}')).toEqual({ discloses: 'no' })
    expect(() => parseJudgeDecision('leak', '{"discloses":"maybe"}')).toThrow(/discloses must be one of yes, no/)
    expect(() => parseJudgeDecision('knows', '{"verdict":"correct"}')).toThrow(/cited must be one of/)
    expect(() => parseJudgeDecision('leak', 'Sure! {"discloses":"no"}')).toThrow(/not JSON/)
  })

  it('the prompt states the closed set and asks for a decision only, no prose', () => {
    const msgs = judgeMessages('judgment', { question: 'Is Jonas pulling his weight?', person: 'Jonas Berg', answer: 'He posted twice.' })
    expect(msgs[0]!.role).toBe('system')
    expect(msgs[0]!.content).toContain('"statement": one of "observation_only" | "contains_judgment" | "no_statement_about_person"')
    expect(msgs[0]!.content).toContain('no other keys')
    expect(msgs[1]!.content).toContain('person: Jonas Berg')
  })
})
