import { describe, expect, it } from 'vitest'
import { decisionKindCatalog, defineDecisionKind, type DecisionKindDef } from './kind'

type In = { text: string }

const base = (): DecisionKindDef<In, 'yes' | 'no'> => ({
  id: 'demo.is_question',
  module: 'demo',
  title: 'Is it a question?',
  instructions: 'Is the text a question?',
  choices: ['yes', 'no'],
  criteria: { yes: 'It asks something.', no: 'It states something.' },
  status: 'shadow',
  lowConfidence: 0,
  state: (i) => i.text,
  logInput: (i) => ({ length: i.text.length }),
})

describe('defineDecisionKind', () => {
  it('returns the kind, frozen (a status changes only by a commit, never at runtime)', () => {
    const kind = defineDecisionKind(base())
    expect(kind.id).toBe('demo.is_question')
    expect(Object.isFrozen(kind)).toBe(true)
    expect(() => {
      ;(kind as { status: string }).status = 'enforced'
    }).toThrow()
  })

  it('refuses a status other than shadow or enforced', () => {
    expect(() => defineDecisionKind({ ...base(), status: 'live' as 'shadow' })).toThrow(/status must be shadow or enforced/)
  })

  it('refuses criteria that are not exactly the closed set of choices', () => {
    expect(() => defineDecisionKind({ ...base(), criteria: { yes: 'y' } as Record<'yes' | 'no', string> })).toThrow(/criteria/)
    expect(() =>
      defineDecisionKind({ ...base(), criteria: { yes: 'y', no: 'n', maybe: 'm' } as Record<'yes' | 'no', string> }),
    ).toThrow(/criteria/)
    expect(() => defineDecisionKind({ ...base(), criteria: { yes: 'y', no: ' ' } })).toThrow(/criteria/)
  })

  it('refuses fewer than two choices and duplicate choices', () => {
    expect(() => defineDecisionKind({ ...base(), choices: ['yes'] as unknown as ['yes', 'no'] })).toThrow(/two/)
    expect(() => defineDecisionKind({ ...base(), choices: ['yes', 'yes'] as unknown as ['yes', 'no'] })).toThrow(/twice/)
  })

  it('refuses an id outside its module namespace', () => {
    expect(() => defineDecisionKind({ ...base(), id: 'other.is_question' })).toThrow(/module/)
    expect(() => defineDecisionKind({ ...base(), id: 'demo' })).toThrow(/module/)
  })

  it('refuses a low-confidence threshold outside 0–1, and one above 0 without someone to ask', () => {
    expect(() => defineDecisionKind({ ...base(), lowConfidence: 1.5 })).toThrow(/lowConfidence/)
    expect(() => defineDecisionKind({ ...base(), lowConfidence: 0.7 })).toThrow(/ask/)
    const kind = defineDecisionKind({
      ...base(),
      lowConfidence: 0.7,
      ask: { who: () => 'u1', question: (i) => `Is “${i.text}” a question?`, labels: { yes: 'Yes', no: 'No' } },
    })
    expect(kind.lowConfidence).toBe(0.7)
  })

  it('refuses ask labels that are not exactly the choices', () => {
    expect(() =>
      defineDecisionKind({
        ...base(),
        lowConfidence: 0.5,
        ask: { who: () => 'u1', question: () => 'q', labels: { yes: 'Yes' } as Record<'yes' | 'no', string> },
      }),
    ).toThrow(/labels/)
  })
})

describe('decisionKindCatalog', () => {
  it('lists the kinds and finds one by id', () => {
    const a = defineDecisionKind(base())
    const b = defineDecisionKind({ ...base(), id: 'demo.other' })
    const catalog = decisionKindCatalog([a, b])
    expect(catalog.list().map((k) => k.id)).toEqual(['demo.is_question', 'demo.other'])
    expect(catalog.get('demo.other')).toBe(b)
    expect(catalog.get('demo.nope')).toBeUndefined()
  })

  it('fails when two kinds share an id', () => {
    const a = defineDecisionKind(base())
    expect(() => decisionKindCatalog([a, defineDecisionKind(base())])).toThrow(/demo.is_question.*twice/)
  })

  it('fails on something that was not made by defineDecisionKind', () => {
    expect(() => decisionKindCatalog([{ ...base() } as never])).toThrow(/defineDecisionKind/)
  })
})
