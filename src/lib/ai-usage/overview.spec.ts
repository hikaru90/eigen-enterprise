import { describe, expect, it } from 'vitest'
import { foldAiUsage, overviewSchema, UNATTRIBUTED_LABEL, type AiUsageRow } from './overview'
import { AI_PRODUCT_IDS, AI_TASK_IDS } from './tasks'

const row = (over: Partial<AiUsageRow>): AiUsageRow => ({
  userId: 'u-mia',
  name: 'Mia',
  kind: 'person',
  task: 'brain.retrieval_rerank',
  model: 'm/one',
  day: '2026-11-20',
  costUsd: 1,
  calls: 2,
  promptTokens: 100,
  completionTokens: 10,
  cachedTokens: 5,
  ...over,
})

const ROWS: AiUsageRow[] = [
  row({}),
  row({ task: 'brain.compose_answer', model: 'm/two', day: '2026-11-21', costUsd: 2, calls: 1 }),
  row({ userId: 'u-cw', name: 'Marketing', kind: 'coworker', task: 'coworkers.turn', costUsd: 4, calls: 3 }),
  row({ task: null, model: null, costUsd: 0.5, calls: 7 }),
]

const fold = (rows: AiUsageRow[]) => foldAiUsage(rows, { from: '2026-11-01', to: '2026-11-27' })

describe('foldAiUsage', () => {
  it('totals the rows', () => {
    expect(fold(ROWS).totals).toEqual({
      costUsd: 7.5,
      calls: 13,
      promptTokens: 400,
      completionTokens: 40,
      cachedTokens: 20,
    })
  })

  it('lists every catalog product with its tasks, also at zero, then the unattributed bucket', () => {
    const out = fold([])
    expect(out.products.map((p) => p.id)).toEqual([...AI_PRODUCT_IDS, 'unattributed'])
    expect(out.products.flatMap((p) => p.tasks.map((t) => t.id)).filter(Boolean)).toEqual([...AI_TASK_IDS])
    expect(out.products.every((p) => p.costUsd === 0 && p.calls === 0)).toBe(true)
    expect(out.totals.costUsd).toBe(0)
    expect(out.people).toEqual([])
    expect(out.models).toEqual([])
    expect(out.daily).toEqual([])
  })

  it('folds tasks into their products and keeps rows without a task apart', () => {
    const out = fold(ROWS)
    const product = (id: string) => out.products.find((p) => p.id === id)!
    expect(product('brain')).toMatchObject({ costUsd: 3, calls: 3 })
    expect(product('brain').tasks.find((t) => t.id === 'brain.retrieval_rerank')).toMatchObject({ costUsd: 1, calls: 2 })
    expect(product('coworkers')).toMatchObject({ costUsd: 4, calls: 3 })
    expect(product('unattributed')).toMatchObject({ label: UNATTRIBUTED_LABEL, costUsd: 0.5, calls: 7 })
    expect(product('unattributed').tasks).toEqual([expect.objectContaining({ id: null, costUsd: 0.5 })])
  })

  it('shows a task id this release does not know under unattributed, by its own name', () => {
    const out = fold([row({ task: 'later.thing', costUsd: 3 })])
    const bucket = out.products.at(-1)!
    expect(bucket.costUsd).toBe(3)
    expect(bucket.tasks.find((t) => t.id === 'later.thing')).toMatchObject({ label: 'Unknown task “later.thing”', costUsd: 3 })
    expect(out.daily[0]!.products).toEqual({ unattributed: 3 })
  })

  it('gives each principal one row with a per-product split, by name, not by amount', () => {
    const out = fold(ROWS)
    expect(out.people.map((p) => [p.name, p.kind, p.costUsd])).toEqual([
      ['Marketing', 'coworker', 4],
      ['Mia', 'person', 3.5],
    ])
    expect(out.people[1]!.products.map((p) => [p.id, p.costUsd])).toEqual([
      ['brain', 3],
      ['unattributed', 0.5],
    ])
  })

  it('totals each model, the unrecorded one last', () => {
    expect(fold(ROWS).models.map((m) => [m.model, m.costUsd, m.calls])).toEqual([
      ['m/one', 5, 5],
      ['m/two', 2, 1],
      [null, 0.5, 7],
    ])
  })

  it('gives the spend of each day per product, in date order', () => {
    expect(fold(ROWS).daily).toEqual([
      { date: '2026-11-20', costUsd: 5.5, products: { brain: 1, coworkers: 4, unattributed: 0.5 } },
      { date: '2026-11-21', costUsd: 2, products: { brain: 2 } },
    ])
  })

  it('answers in the declared shape', () => {
    expect(overviewSchema.parse(fold(ROWS))).toEqual(fold(ROWS))
  })
})
