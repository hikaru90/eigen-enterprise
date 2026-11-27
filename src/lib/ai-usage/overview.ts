import { z } from 'zod'
import { AI_PRODUCT_IDS, AI_PRODUCTS, AI_TASK_IDS, AI_TASKS, isAiTaskId, type AiProductId } from './tasks'

/**
 * The company's AI usage (plan/phase-ai-usage-overview.md §4): the cost log's grouped rows
 * folded into products, principals, models and days. Observation only: amounts and counts.
 * People and models are listed by name, never ordered by amount. Client-safe.
 */

/** The bucket of rows that name no task. */
export const UNATTRIBUTED_ID = 'unattributed'
export const UNATTRIBUTED_LABEL = 'Not attributed (before task tracking)'
export type AiUsageProductId = AiProductId | typeof UNATTRIBUTED_ID

/** The products in their one display order, the unattributed bucket last. */
export const USAGE_PRODUCT_IDS: readonly AiUsageProductId[] = [...AI_PRODUCT_IDS, UNATTRIBUTED_ID]

export function usageProductLabel(id: AiUsageProductId): string {
  return id === UNATTRIBUTED_ID ? UNATTRIBUTED_LABEL : AI_PRODUCTS[id].label
}

/** One group of the cost log: (principal, task, model, UTC day). */
export type AiUsageRow = {
  userId: string
  name: string
  kind: 'person' | 'coworker'
  task: string | null
  model: string | null
  /** UTC date, YYYY-MM-DD. */
  day: string
  costUsd: number
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
}

const amountsShape = {
  /** USD, what the company is billed (activity_call_log.total_cost_usd). */
  costUsd: z.number().nonnegative(),
  /** Gateway calls, failed attempts included. */
  calls: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
}
const amountsSchema = z.object(amountsShape)
export type AiAmounts = z.infer<typeof amountsSchema>

const productIdSchema = z.enum(USAGE_PRODUCT_IDS as [AiUsageProductId, ...AiUsageProductId[]])

export const overviewSchema = z.object({
  /** The period asked for (UTC dates, both included); null = open. */
  from: z.string().nullable(),
  to: z.string().nullable(),
  totals: amountsSchema,
  products: z.array(
    z.object({
      id: productIdSchema,
      label: z.string(),
      ...amountsShape,
      tasks: z.array(z.object({ id: z.string().nullable(), label: z.string(), ...amountsShape })),
    }),
  ),
  people: z.array(
    z.object({
      userId: z.string(),
      name: z.string(),
      kind: z.enum(['person', 'coworker']),
      ...amountsShape,
      products: z.array(z.object({ id: productIdSchema, label: z.string(), ...amountsShape })),
    }),
  ),
  models: z.array(z.object({ model: z.string().nullable(), ...amountsShape })),
  daily: z.array(
    z.object({
      date: z.string(),
      costUsd: z.number().nonnegative(),
      /** USD per product that had calls that day. */
      products: z.record(z.string(), z.number().nonnegative()),
    }),
  ),
})
export type AiUsageOverview = z.infer<typeof overviewSchema>

const zero = (): AiAmounts => ({ costUsd: 0, calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0 })

/** USD sums of 6-place amounts, without float residue. */
const usd = (value: number) => Math.round(value * 1e8) / 1e8

function add(into: AiAmounts, row: AiAmounts): void {
  into.costUsd = usd(into.costUsd + row.costUsd)
  into.calls += row.calls
  into.promptTokens += row.promptTokens
  into.completionTokens += row.completionTokens
  into.cachedTokens += row.cachedTokens
}

function bucket<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let value = map.get(key)
  if (value === undefined) {
    value = make()
    map.set(key, value)
  }
  return value
}

const productOfTask = (task: string | null): AiUsageProductId =>
  task !== null && isAiTaskId(task) ? AI_TASKS[task].product : UNATTRIBUTED_ID

const taskLabel = (task: string | null): string => {
  if (task === null) return UNATTRIBUTED_LABEL
  return isAiTaskId(task) ? AI_TASKS[task].label : `Unknown task “${task}”`
}

export function foldAiUsage(rows: readonly AiUsageRow[], period: { from: string | null; to: string | null }): AiUsageOverview {
  const totals = zero()
  const tasks = new Map<string | null, AiAmounts>()
  const people = new Map<string, { name: string; kind: 'person' | 'coworker'; amounts: AiAmounts; products: Map<AiUsageProductId, AiAmounts> }>()
  const models = new Map<string | null, AiAmounts>()
  const days = new Map<string, { costUsd: number; products: Map<AiUsageProductId, number> }>()

  for (const row of rows) {
    const product = productOfTask(row.task)
    add(totals, row)
    add(bucket(tasks, row.task, zero), row)
    add(bucket(models, row.model, zero), row)
    const person = bucket(people, row.userId, () => ({ name: row.name, kind: row.kind, amounts: zero(), products: new Map<AiUsageProductId, AiAmounts>() }))
    add(person.amounts, row)
    add(bucket(person.products, product, zero), row)
    const day = bucket(days, row.day, () => ({ costUsd: 0, products: new Map<AiUsageProductId, number>() }))
    day.costUsd = usd(day.costUsd + row.costUsd)
    day.products.set(product, usd((day.products.get(product) ?? 0) + row.costUsd))
  }

  // Every catalog task, used or not; ids this release does not know join the unattributed bucket.
  const taskIds: (string | null)[] = [...AI_TASK_IDS, ...[...tasks.keys()].filter((id) => id !== null && !isAiTaskId(id))]
  if (tasks.has(null)) taskIds.push(null)

  return {
    from: period.from,
    to: period.to,
    totals,
    products: USAGE_PRODUCT_IDS.map((id) => {
      const own = taskIds
        .filter((task) => productOfTask(task) === id)
        .map((task) => ({ id: task, label: taskLabel(task), ...(tasks.get(task) ?? zero()) }))
      const sum = zero()
      for (const task of own) add(sum, task)
      return { id, label: usageProductLabel(id), ...sum, tasks: own }
    }),
    people: [...people]
      .map(([userId, p]) => ({
        userId,
        name: p.name,
        kind: p.kind,
        ...p.amounts,
        products: USAGE_PRODUCT_IDS.filter((id) => p.products.has(id)).map((id) => ({ id, label: usageProductLabel(id), ...p.products.get(id)! })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
    models: [...models]
      .map(([model, amounts]) => ({ model, ...amounts }))
      .sort((a, b) => (a.model === null ? 1 : b.model === null ? -1 : a.model.localeCompare(b.model))),
    daily: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => ({
        date,
        costUsd: day.costUsd,
        products: Object.fromEntries(USAGE_PRODUCT_IDS.filter((id) => day.products.has(id)).map((id) => [id, day.products.get(id)!])),
      })),
  }
}
