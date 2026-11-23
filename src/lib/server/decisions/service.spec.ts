import { describe, expect, it, vi } from 'vitest'
import type { LlmDecideResult } from '$lib/server/llm/llm-decide'
import { decide, type DecideDeps } from './decide'
import { decisionKindCatalog, defineDecisionKind } from './kind'
import { decisionsPort } from './service'
import { inMemoryDecisionStore } from './store'

type In = { id: number }

const shadowKind = defineDecisionKind<In, 'yes' | 'no'>({
  id: 'demo.shadowed',
  module: 'demo',
  title: 'Shadowed',
  instructions: 'Yes or no?',
  choices: ['yes', 'no'],
  criteria: { yes: 'y', no: 'n' },
  status: 'shadow',
  lowConfidence: 0,
  state: (i) => `case ${i.id}`,
  logInput: (i) => ({ id: i.id }),
})

const enforcedKind = defineDecisionKind<In, 'yes' | 'no'>({
  id: 'demo.enforced',
  module: 'demo',
  title: 'Should we share it?',
  instructions: 'Share?',
  choices: ['yes', 'no'],
  criteria: { yes: 'y', no: 'n' },
  status: 'enforced',
  lowConfidence: 0.7,
  state: (i) => `case ${i.id}`,
  logInput: (i) => ({ id: i.id }),
  ask: { who: () => 'u-owner', question: (i) => `Share case ${i.id}?`, labels: { yes: 'Share it', no: 'Keep it' } },
})

const catalog = decisionKindCatalog([shadowKind, enforcedKind])

const jev = (choice: 'yes' | 'no', confidence: number): DecideDeps['ask'] =>
  vi.fn(async (): Promise<LlmDecideResult> => ({
    model: 'jev',
    answers: { decision: { choice, confidence, distribution: { yes: 0.5, no: 0.5 } } },
    costUsd: 0.00001,
    durationMs: 1,
  }))

describe('decisions port over the log', () => {
  it('agreement per kind: Jev against the current judge in shadow, against the person’s answer when there is one', async () => {
    const store = inMemoryDecisionStore()
    const port = decisionsPort(store, catalog, () => new Date('2026-11-23T10:00:00Z'))
    // shadow: 3 compared, 2 agree; 1 Jev error (not compared)
    await decide(shadowKind, { id: 1 }, { requestedBy: 'u1', judge: { current: async () => 'yes' } }, { ask: jev('yes', 0.9), store })
    await decide(shadowKind, { id: 2 }, { requestedBy: 'u1', judge: { current: async () => 'no' } }, { ask: jev('no', 0.9), store })
    await decide(shadowKind, { id: 3 }, { requestedBy: 'u1', judge: { current: async () => 'no' } }, { ask: jev('yes', 0.9), store })
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await decide(shadowKind, { id: 4 }, { requestedBy: 'u1', judge: { current: async () => 'no' } }, { ask: vi.fn(async () => Promise.reject(new Error('down'))), store })
    // enforced: a question, answered against Jev's lean
    const q = await decide(enforcedKind, { id: 5 }, { requestedBy: 'u1', judge: { none: true } }, { ask: jev('yes', 0.5), store })
    await port.answer('u-owner', q.decisionId, 'no')

    const kinds = await port.kinds()
    expect(kinds.find((k) => k.id === 'demo.shadowed')).toMatchObject({
      declared: true,
      status: 'shadow',
      total: 4,
      judgeCompared: 3,
      judgeAgreed: 2,
      compared: 3,
      agreed: 2,
      agreement: 2 / 3,
      jevErrors: 1,
    })
    expect(kinds.find((k) => k.id === 'demo.enforced')).toMatchObject({
      status: 'enforced',
      total: 1,
      humanCompared: 1,
      humanAgreed: 0,
      agreement: 0,
      openQuestions: 0,
    })
  })

  it('a declared kind with no decisions yet shows zero counts and no agreement', async () => {
    const kinds = await decisionsPort(inMemoryDecisionStore(), catalog).kinds()
    expect(kinds.map((k) => [k.id, k.total, k.agreement])).toEqual([
      ['demo.shadowed', 0, null],
      ['demo.enforced', 0, null],
    ])
  })

  it('a person’s open questions carry the kind’s labels; answering logs the human label and closes it', async () => {
    const store = inMemoryDecisionStore()
    const port = decisionsPort(store, catalog, () => new Date('2026-11-23T10:00:00Z'))
    const q = await decide(enforcedKind, { id: 7 }, { requestedBy: 'u1', judge: { none: true } }, { ask: jev('yes', 0.4), store })
    expect(await port.questions('u-owner')).toEqual([
      {
        id: q.decisionId,
        kind: 'demo.enforced',
        title: 'Should we share it?',
        question: 'Share case 7?',
        choices: [
          { choice: 'yes', label: 'Share it' },
          { choice: 'no', label: 'Keep it' },
        ],
        askedAt: expect.any(String),
      },
    ])
    expect(await port.questions('u1')).toEqual([])
    await expect(port.answer('u-owner', q.decisionId, 'yes')).resolves.toEqual({ decisionId: q.decisionId, kind: 'demo.enforced', choice: 'yes' })
    expect(store.rows()[0]).toMatchObject({ humanChoice: 'yes', labelledBy: 'u-owner', usedChoice: 'yes', usedSource: 'human' })
    expect(await port.questions('u-owner')).toEqual([])
  })

  it('only the person asked answers, once, from the closed set', async () => {
    const store = inMemoryDecisionStore()
    const port = decisionsPort(store, catalog)
    const q = await decide(enforcedKind, { id: 8 }, { requestedBy: 'u1', judge: { none: true } }, { ask: jev('yes', 0.4), store })
    await expect(port.answer('u1', q.decisionId, 'yes')).rejects.toThrow(/no decision question/)
    await expect(port.answer('u-owner', q.decisionId, 'maybe')).rejects.toThrow(/not an answer/)
    await port.answer('u-owner', q.decisionId, 'no')
    await expect(port.answer('u-owner', q.decisionId, 'yes')).rejects.toThrow(/already answered/)
  })

  it('the log: every row for a full reader, a reader’s own rows otherwise', async () => {
    const store = inMemoryDecisionStore()
    const port = decisionsPort(store, catalog)
    await decide(shadowKind, { id: 1 }, { requestedBy: 'u1', judge: { current: async () => 'yes' } }, { ask: jev('yes', 1), store })
    await decide(shadowKind, { id: 2 }, { requestedBy: 'u2', subjectUserId: 'u3', judge: { current: async () => 'yes' } }, { ask: jev('yes', 1), store })
    expect((await port.log({ limit: 50, readerId: null })).map((r) => r.input)).toEqual([{ id: 2 }, { id: 1 }])
    expect((await port.log({ limit: 50, readerId: 'u1' })).map((r) => r.input)).toEqual([{ id: 1 }])
    expect((await port.log({ limit: 50, readerId: 'u3' })).map((r) => r.input)).toEqual([{ id: 2 }])
    expect(await port.log({ limit: 50, readerId: 'u9' })).toEqual([])
  })
})
