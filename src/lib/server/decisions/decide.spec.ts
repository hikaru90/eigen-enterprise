import { describe, expect, it, vi } from 'vitest'
import { DecisionOutOfSetError, type LlmDecideResult } from '$lib/server/llm/llm-decide'
import { decide, decideMany, inputDigest, type DecideDeps } from './decide'
import { defineDecisionKind, type DecisionKindDef } from './kind'
import { inMemoryDecisionStore } from './store'

type Mail = { from: string; subject: string; body: string; api_key?: string }
type Choice = 'yes' | 'no'

const def = (over: Partial<DecisionKindDef<Mail, Choice>> = {}): DecisionKindDef<Mail, Choice> => ({
  id: 'demo.mail_mine',
  module: 'demo',
  title: 'Is this mail mine to act on?',
  instructions: 'Should the finance co-worker act on this mail?',
  choices: ['yes', 'no'],
  criteria: { yes: 'It asks for finance work.', no: 'It does not.' },
  status: 'shadow',
  lowConfidence: 0,
  state: (m) => `From ${m.from}: ${m.subject}\n${m.body}`,
  logInput: (m) => ({ from: m.from, subject: m.subject, api_key: m.api_key }),
  ...over,
})

const mail: Mail = { from: 'anna@acme.test', subject: 'Invoice #44', body: 'Wrong VAT, private details', api_key: 'sk-live-123' }

function jevSays(choice: string, confidence: number): DecideDeps['ask'] {
  return vi.fn(
    async (): Promise<LlmDecideResult> => ({
      model: 'typesafe/jev-1.13-20260917',
      answers: { decision: { choice, confidence, distribution: { yes: choice === 'yes' ? confidence : 1 - confidence, no: choice === 'no' ? confidence : 1 - confidence } } },
      costUsd: 0.000017,
      durationMs: 300,
    }),
  )
}

function setup(ask: DecideDeps['ask']) {
  const store = inMemoryDecisionStore()
  return { store, deps: { ask, store } satisfies DecideDeps }
}

describe('decide — shadow', () => {
  it("logs Jev's choice next to the current judge's and returns the current judge's answer", async () => {
    const kind = defineDecisionKind(def())
    const { store, deps } = setup(jevSays('no', 0.9))
    const judge = vi.fn(async (): Promise<Choice> => 'yes')
    const out = await decide(kind, mail, { requestedBy: 'u1', judge: { current: judge } }, deps)
    expect(out).toMatchObject({
      outcome: 'decided',
      choice: 'yes',
      source: 'current_judge',
      confidence: null,
      kind: 'demo.mail_mine',
      status: 'shadow',
      jev: { choice: 'no', confidence: 0.9 },
    })
    expect(judge).toHaveBeenCalledTimes(1)
    const [row] = store.rows()
    expect(row).toMatchObject({
      id: out.decisionId,
      kind: 'demo.mail_mine',
      module: 'demo',
      status: 'shadow',
      outcome: 'decided',
      jevChoice: 'no',
      jevConfidence: 0.9,
      judgeChoice: 'yes',
      usedChoice: 'yes',
      usedSource: 'current_judge',
      requestedBy: 'u1',
      model: 'typesafe/jev-1.13-20260917',
      costUsd: 0.000017,
      inputDigest: inputDigest(mail),
    })
  })

  it('asks Jev with the kind’s state, closed set and criteria, the cost on the requesting user', async () => {
    const kind = defineDecisionKind(def())
    const ask = jevSays('yes', 1)
    await decide(kind, mail, { requestedBy: 'u1', judge: { current: async () => 'yes' } }, setup(ask).deps)
    expect(ask).toHaveBeenCalledWith({
      userId: 'u1',
      state: 'From anna@acme.test: Invoice #44\nWrong VAT, private details',
      questions: { decision: { instructions: kind.instructions, criteria: kind.criteria } },
      task: 'decisions.judge',
      kindId: 'demo.mail_mine',
    })
  })

  it('keeps only the kind’s log view of the input, secrets redacted — never the state', async () => {
    const kind = defineDecisionKind(def())
    const { store, deps } = setup(jevSays('yes', 1))
    await decide(kind, mail, { requestedBy: 'u1', judge: { current: async () => 'yes' } }, deps)
    const [row] = store.rows()
    expect(row!.input).toEqual({ from: 'anna@acme.test', subject: 'Invoice #44', api_key: '[REDACTED]' })
    expect(JSON.stringify(row)).not.toContain('private details')
    expect(JSON.stringify(row)).not.toContain('sk-live-123')
  })

  it('a Jev failure (an answer outside the closed set, no key, …) is logged; the current judge’s answer stands', async () => {
    const kind = defineDecisionKind(def())
    const ask = vi.fn(async () => Promise.reject(new DecisionOutOfSetError('decision', 'perhaps', ['yes', 'no'])))
    const { store, deps } = setup(ask)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await decide(kind, mail, { requestedBy: 'u1', judge: { current: async () => 'no' } }, deps)
    expect(out).toMatchObject({ outcome: 'decided', choice: 'no', source: 'current_judge', jev: null })
    expect(store.rows()[0]).toMatchObject({ jevChoice: null, judgeChoice: 'no', jevError: expect.stringContaining('perhaps') })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('a current judge that fails fails the call (production behaviour is the judge’s)', async () => {
    const kind = defineDecisionKind(def())
    const { deps } = setup(jevSays('yes', 1))
    await expect(
      decide(kind, mail, { requestedBy: 'u1', judge: { current: async () => Promise.reject(new Error('judge down')) } }, deps),
    ).rejects.toThrow('judge down')
  })

  it('a current judge answering outside the closed set fails loud', async () => {
    const kind = defineDecisionKind(def())
    const { deps } = setup(jevSays('yes', 1))
    await expect(
      decide(kind, mail, { requestedBy: 'u1', judge: { current: async () => 'maybe' as Choice } }, deps),
    ).rejects.toThrow(/maybe/)
  })

  it('with no current judge (new behaviour): logs Jev’s answer and returns observed — nothing to act on', async () => {
    const kind = defineDecisionKind(def())
    const { store, deps } = setup(jevSays('yes', 0.95))
    const out = await decide(kind, mail, { requestedBy: 'cw1', subjectUserId: 'cw1', judge: { none: true } }, deps)
    expect(out).toEqual({
      outcome: 'observed',
      act: false,
      kind: 'demo.mail_mine',
      status: 'shadow',
      decisionId: expect.any(String),
      jev: { choice: 'yes', confidence: 0.95, distribution: { yes: 0.95, no: expect.closeTo(0.05) } },
    })
    expect('choice' in out).toBe(false)
    expect(store.rows()[0]).toMatchObject({ outcome: 'observed', usedChoice: null, usedSource: null, judgeChoice: null, subjectUserId: 'cw1' })
  })
})

describe('decide — enforced', () => {
  const ask = {
    who: () => 'owner-1',
    question: (m: Mail) => `Should finance act on “${m.subject}”?`,
    labels: { yes: 'Yes, act', no: 'No' },
  }

  it("uses Jev's answer and does not run the current judge", async () => {
    const kind = defineDecisionKind(def({ status: 'enforced', lowConfidence: 0.6, ask }))
    const { store, deps } = setup(jevSays('yes', 0.92))
    const judge = vi.fn(async (): Promise<Choice> => 'no')
    const out = await decide(kind, mail, { requestedBy: 'u1', judge: { current: judge } }, deps)
    expect(out).toMatchObject({ outcome: 'decided', choice: 'yes', confidence: 0.92, source: 'jev', status: 'enforced' })
    expect(judge).not.toHaveBeenCalled()
    expect(store.rows()[0]).toMatchObject({ usedChoice: 'yes', usedSource: 'jev', judgeChoice: null })
  })

  it('below the threshold: a Needs you question for the person askWho names, instead of a guess', async () => {
    const kind = defineDecisionKind(def({ status: 'enforced', lowConfidence: 0.6, ask }))
    const { store, deps } = setup(jevSays('yes', 0.55))
    const out = await decide(kind, mail, { requestedBy: 'u1', judge: { none: true } }, deps)
    expect(out).toMatchObject({ outcome: 'pending', pending: true, questionId: out.decisionId, status: 'enforced' })
    expect('choice' in out).toBe(false)
    expect(store.rows()[0]).toMatchObject({
      outcome: 'pending',
      askUserId: 'owner-1',
      question: 'Should finance act on “Invoice #44”?',
      jevChoice: 'yes',
      usedChoice: null,
    })
  })

  it('asking again while the question is open returns the same question; once answered, the person’s answer — no new Jev call', async () => {
    const kind = defineDecisionKind(def({ status: 'enforced', lowConfidence: 0.6, ask }))
    const jev = jevSays('yes', 0.5)
    const { store, deps } = setup(jev)
    const first = await decide(kind, mail, { requestedBy: 'u1', judge: { none: true } }, deps)
    const again = await decide(kind, mail, { requestedBy: 'u1', judge: { none: true } }, deps)
    expect(again).toMatchObject({ outcome: 'pending', questionId: first.decisionId })
    expect(jev).toHaveBeenCalledTimes(1)
    expect(await store.label(first.decisionId, 'no', 'owner-1', new Date())).toBe(true)
    const answered = await decide(kind, mail, { requestedBy: 'u1', judge: { none: true } }, deps)
    expect(answered).toMatchObject({ outcome: 'decided', choice: 'no', source: 'human', confidence: null, decisionId: first.decisionId })
    expect(jev).toHaveBeenCalledTimes(1)
    expect(store.rows()).toHaveLength(1)
  })

  it('below the threshold with no one to ask fails loud (never a guess)', async () => {
    const kind = defineDecisionKind(def({ status: 'enforced', lowConfidence: 0.6, ask: { ...ask, who: () => null } }))
    const { store, deps } = setup(jevSays('yes', 0.3))
    await expect(decide(kind, mail, { requestedBy: 'u1', judge: { none: true } }, deps)).rejects.toThrow(/no one to ask/)
    expect(store.rows()[0]).toMatchObject({ outcome: 'failed' })
  })

  it('a Jev failure fails the call (an enforced kind has no fallback) and is logged', async () => {
    const kind = defineDecisionKind(def({ status: 'enforced' }))
    const { store, deps } = setup(vi.fn(async () => Promise.reject(new Error('gateway down'))))
    await expect(decide(kind, mail, { requestedBy: 'u1', judge: { none: true } }, deps)).rejects.toThrow('gateway down')
    expect(store.rows()[0]).toMatchObject({ outcome: 'failed', jevError: 'Error: gateway down', usedChoice: null })
  })
})

describe('decideMany — one Jev call, many questions about one state', () => {
  /** One mail, asked once per co-worker: the mail is the shared state, each co-worker's role its question's context. */
  type Routed = { mail: Mail; coworker: { id: string; role: string } }
  const routedDef = (over: Partial<DecisionKindDef<Routed, Choice>> = {}): DecisionKindDef<Routed, Choice> => ({
    id: 'demo.mail_routed',
    module: 'demo',
    title: 'Is this mail this co-worker’s?',
    instructions: 'Should this co-worker act on the mail?',
    choices: ['yes', 'no'],
    criteria: { yes: 'It is its work.', no: 'It is not.' },
    status: 'shadow',
    lowConfidence: 0,
    state: (r) => `${r.coworker.role}\n${r.mail.subject}`,
    batch: { state: (r) => `From ${r.mail.from}: ${r.mail.subject}`, question: (r) => `The co-worker: ${r.coworker.role}` },
    logInput: (r) => ({ coworker: r.coworker.id, subject: r.mail.subject }),
    ...over,
  })
  const items = [
    { input: { mail, coworker: { id: 'cw-fin', role: 'Finance' } }, subjectUserId: 'cw-fin' },
    { input: { mail, coworker: { id: 'cw-ops', role: 'Operations' } }, subjectUserId: 'cw-ops' },
  ]
  /** Jev answers q0, q1, … in order. */
  function jevAnswers(...answers: Array<[string, number]>): DecideDeps['ask'] {
    return vi.fn(
      async (): Promise<LlmDecideResult> => ({
        model: 'typesafe/jev-1.13-20260917',
        answers: Object.fromEntries(
          answers.map(([choice, confidence], n) => [`q${n}`, { choice, confidence, distribution: { yes: choice === 'yes' ? confidence : 1 - confidence, no: choice === 'no' ? confidence : 1 - confidence } }]),
        ),
        costUsd: 0.00003,
        durationMs: 200,
      }),
    )
  }

  it('asks Jev once: the shared state, one question per item with its own context, the cost on the requesting user', async () => {
    const kind = defineDecisionKind(routedDef())
    const ask = jevAnswers(['yes', 0.8], ['no', 0.7])
    await decideMany(kind, items, { requestedBy: 'author-1', judge: { none: true } }, setup(ask).deps)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask).toHaveBeenCalledWith({
      userId: 'author-1',
      state: 'From anna@acme.test: Invoice #44',
      questions: {
        q0: { instructions: 'Should this co-worker act on the mail?\n\nThe co-worker: Finance', criteria: kind.criteria },
        q1: { instructions: 'Should this co-worker act on the mail?\n\nThe co-worker: Operations', criteria: kind.criteria },
      },
      task: 'decisions.judge',
      kindId: 'demo.mail_routed',
    })
  })

  it('shadow, no current judge: one observed row per item, in order, the call’s cost split over them', async () => {
    const kind = defineDecisionKind(routedDef())
    const { store, deps } = setup(jevAnswers(['yes', 0.8], ['no', 0.7]))
    const out = await decideMany(kind, items, { requestedBy: 'author-1', judge: { none: true } }, deps)
    expect(out).toEqual([
      expect.objectContaining({ outcome: 'observed', act: false, jev: expect.objectContaining({ choice: 'yes', confidence: 0.8 }) }),
      expect.objectContaining({ outcome: 'observed', act: false, jev: expect.objectContaining({ choice: 'no', confidence: 0.7 }) }),
    ])
    const rows = store.rows()
    expect(rows.map((r) => r.id)).toEqual(out.map((r) => r.decisionId))
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'demo.mail_routed', outcome: 'observed', jevChoice: 'yes', requestedBy: 'author-1', subjectUserId: 'cw-fin', inputDigest: inputDigest(items[0]!.input), durationMs: 200 }),
      expect.objectContaining({ kind: 'demo.mail_routed', outcome: 'observed', jevChoice: 'no', requestedBy: 'author-1', subjectUserId: 'cw-ops', inputDigest: inputDigest(items[1]!.input), durationMs: 200 }),
    ])
    expect(rows.map((r) => r.input)).toEqual([{ coworker: 'cw-fin', subject: 'Invoice #44' }, { coworker: 'cw-ops', subject: 'Invoice #44' }])
    // The per-kind cost sum (decisions.kinds) stays the call's cost.
    expect(rows[0]!.costUsd! + rows[1]!.costUsd!).toBeCloseTo(0.00003, 12)
  })

  it('shadow, no current judge: a Jev failure is logged on every row and returns observed with no answer', async () => {
    const kind = defineDecisionKind(routedDef())
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, deps } = setup(vi.fn(async () => Promise.reject(new Error('gateway down'))))
    const out = await decideMany(kind, items, { requestedBy: 'author-1', judge: { none: true } }, deps)
    expect(out.map((r) => [r.outcome, 'jev' in r ? r.jev : 'x'])).toEqual([['observed', null], ['observed', null]])
    expect(store.rows().map((r) => r.jevError)).toEqual(['Error: gateway down', 'Error: gateway down'])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('shadow with a current judge: each item’s judge answer is used, Jev logged beside it', async () => {
    const kind = defineDecisionKind(routedDef())
    const { store, deps } = setup(jevAnswers(['yes', 0.8], ['yes', 0.6]))
    const judge = vi.fn(async (r: Routed): Promise<Choice> => (r.coworker.id === 'cw-fin' ? 'yes' : 'no'))
    const out = await decideMany(kind, items, { requestedBy: 'author-1', judge: { current: judge } }, deps)
    expect(out.map((r) => (r.outcome === 'decided' ? [r.choice, r.source] : r.outcome))).toEqual([['yes', 'current_judge'], ['no', 'current_judge']])
    expect(store.rows().map((r) => [r.jevChoice, r.judgeChoice])).toEqual([['yes', 'yes'], ['yes', 'no']])
  })

  it('enforced: Jev’s answer per item; below the threshold that item asks a person; an open question is not asked again', async () => {
    const ask = { who: () => 'owner-1', question: (r: Routed) => `Is “${r.mail.subject}” ${r.coworker.role}’s?`, labels: { yes: 'Yes', no: 'No' } }
    const kind = defineDecisionKind(routedDef({ status: 'enforced', lowConfidence: 0.6, ask }))
    const jev = jevAnswers(['yes', 0.9], ['no', 0.4])
    const { store, deps } = setup(jev)
    const first = await decideMany(kind, items, { requestedBy: 'author-1', judge: { none: true } }, deps)
    expect(first[0]).toMatchObject({ outcome: 'decided', choice: 'yes', source: 'jev' })
    expect(first[1]).toMatchObject({ outcome: 'pending' })
    expect(store.rows()[1]).toMatchObject({ outcome: 'pending', askUserId: 'owner-1', question: 'Is “Invoice #44” Operations’s?' })
    // Asked again: the open question stands for cw-ops; only cw-fin goes to Jev, alone in the call.
    const again = await decideMany(kind, items, { requestedBy: 'author-1', judge: { none: true } }, deps)
    expect(again[1]).toMatchObject({ outcome: 'pending', questionId: first[1]!.decisionId })
    expect(jev).toHaveBeenCalledTimes(2)
    expect(Object.keys((jev as ReturnType<typeof vi.fn>).mock.calls[1]![0].questions)).toEqual(['q0'])
  })

  it('enforced: a Jev failure logs every item as failed and fails the call', async () => {
    const kind = defineDecisionKind(routedDef({ status: 'enforced' }))
    const { store, deps } = setup(vi.fn(async () => Promise.reject(new Error('gateway down'))))
    await expect(decideMany(kind, items, { requestedBy: 'author-1', judge: { none: true } }, deps)).rejects.toThrow('gateway down')
    expect(store.rows().map((r) => r.outcome)).toEqual(['failed', 'failed'])
  })

  it('fails loud: no items, a kind without a batch shape, items that do not share one state', async () => {
    const { deps } = setup(jevAnswers(['yes', 1]))
    const kind = defineDecisionKind(routedDef())
    await expect(decideMany(kind, [], { requestedBy: 'u1', judge: { none: true } }, deps)).rejects.toThrow(/at least one/)
    const single = defineDecisionKind(def())
    await expect(decideMany(single, [{ input: mail }], { requestedBy: 'u1', judge: { none: true } }, deps)).rejects.toThrow(/batch/)
    const other = { input: { mail: { ...mail, subject: 'Another' }, coworker: { id: 'cw-x', role: 'X' } } }
    await expect(decideMany(kind, [items[0]!, other], { requestedBy: 'u1', judge: { none: true } }, deps)).rejects.toThrow(/one state/)
    expect(deps.ask).not.toHaveBeenCalled()
  })
})

describe('inputDigest', () => {
  it('is the same for the same input whatever the key order', () => {
    expect(inputDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(inputDigest({ b: { d: 3, c: 2 }, a: 1 }))
    expect(inputDigest({ a: 1 })).not.toBe(inputDigest({ a: 2 }))
  })
})
