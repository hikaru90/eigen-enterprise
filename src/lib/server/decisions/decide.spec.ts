import { describe, expect, it, vi } from 'vitest'
import { DecisionOutOfSetError, type LlmDecideResult } from '$lib/server/llm/llm-decide'
import { decide, inputDigest, type DecideDeps } from './decide'
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
      logContext: 'demo.mail_mine',
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

describe('inputDigest', () => {
  it('is the same for the same input whatever the key order', () => {
    expect(inputDigest({ a: 1, b: { c: 2, d: 3 } })).toBe(inputDigest({ b: { d: 3, c: 2 }, a: 1 }))
    expect(inputDigest({ a: 1 })).not.toBe(inputDigest({ a: 2 }))
  })
})
