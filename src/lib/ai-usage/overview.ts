import { z } from 'zod'
import { aiBillingSchema, invoicedEur, type AiBilling } from './billing'
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
  /** USD the provider reported for the group's eigenInference calls (provider `platform`, base_cost_usd): what the hosting invoices from. */
  eigenInferenceUsd: number
}

const amountsShape = {
  /** USD, what the company is billed (activity_call_log.total_cost_usd). */
  costUsd: z.number().nonnegative(),
  /** Gateway calls, failed attempts included. */
  calls: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  cachedTokens: z.number().int().nonnegative(),
  /** Hosted with eigenInference only (billing set): the provider-reported USD of the eigenInference calls. */
  providerUsd: z.number().nonnegative().optional(),
  /** Hosted with eigenInference only: what the company is invoiced for them, EUR = providerUsd × markup × usdToEur. */
  invoicedEur: z.number().nonnegative().optional(),
}
const amountsSchema = z.object(amountsShape)
export type AiAmounts = z.infer<typeof amountsSchema>

const productIdSchema = z.enum(USAGE_PRODUCT_IDS as [AiUsageProductId, ...AiUsageProductId[]])

export const overviewSchema = z.object({
  /** The period asked for (UTC dates, both included); null = open. */
  from: z.string().nullable(),
  to: z.string().nullable(),
  /** How the hosting invoices eigenInference (hosted plan); null = self-hosted or no eigenInference: USD as logged. */
  billing: aiBillingSchema.nullable(),
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
      /** Billing set only: the day's € invoiced, in total and per product that had calls. */
      invoicedEur: z.number().nonnegative().optional(),
      productsEur: z.record(z.string(), z.number().nonnegative()).optional(),
    }),
  ),
})
export type AiUsageOverview = z.infer<typeof overviewSchema>

/** A running sum: the shown amounts and the eigenInference base they are invoiced from. */
type Sum = {
  costUsd: number
  calls: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  eigenInferenceUsd: number
}

const zero = (): Sum => ({ costUsd: 0, calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, eigenInferenceUsd: 0 })

/** USD sums of 6-place amounts, without float residue. */
const usd = (value: number) => Math.round(value * 1e8) / 1e8

function add(into: Sum, row: Sum): void {
  into.costUsd = usd(into.costUsd + row.costUsd)
  into.calls += row.calls
  into.promptTokens += row.promptTokens
  into.completionTokens += row.completionTokens
  into.cachedTokens += row.cachedTokens
  into.eigenInferenceUsd = usd(into.eigenInferenceUsd + row.eigenInferenceUsd)
}

/** A sum as the overview shows it: USD as logged, and with billing its provider USD and € invoiced. */
function shown(sum: Sum, billing: AiBilling | null): AiAmounts {
  const { eigenInferenceUsd, ...amounts } = sum
  if (billing === null) return amounts
  return { ...amounts, providerUsd: eigenInferenceUsd, invoicedEur: invoicedEur(eigenInferenceUsd, billing) }
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

export function foldAiUsage(
  rows: readonly AiUsageRow[],
  period: { from: string | null; to: string | null },
  billing: AiBilling | null = null,
): AiUsageOverview {
  const totals = zero()
  const tasks = new Map<string | null, Sum>()
  const people = new Map<string, { name: string; kind: 'person' | 'coworker'; amounts: Sum; products: Map<AiUsageProductId, Sum> }>()
  const models = new Map<string | null, Sum>()
  const days = new Map<string, { costUsd: number; products: Map<AiUsageProductId, number>; eigenInference: Map<AiUsageProductId, number> }>()

  for (const row of rows) {
    const product = productOfTask(row.task)
    add(totals, row)
    add(bucket(tasks, row.task, zero), row)
    add(bucket(models, row.model, zero), row)
    const person = bucket(people, row.userId, () => ({ name: row.name, kind: row.kind, amounts: zero(), products: new Map<AiUsageProductId, Sum>() }))
    add(person.amounts, row)
    add(bucket(person.products, product, zero), row)
    const day = bucket(days, row.day, () => ({ costUsd: 0, products: new Map<AiUsageProductId, number>(), eigenInference: new Map<AiUsageProductId, number>() }))
    day.costUsd = usd(day.costUsd + row.costUsd)
    day.products.set(product, usd((day.products.get(product) ?? 0) + row.costUsd))
    day.eigenInference.set(product, usd((day.eigenInference.get(product) ?? 0) + row.eigenInferenceUsd))
  }

  // Every catalog task, used or not; ids this release does not know join the unattributed bucket.
  const taskIds: (string | null)[] = [...AI_TASK_IDS, ...[...tasks.keys()].filter((id) => id !== null && !isAiTaskId(id))]
  if (tasks.has(null)) taskIds.push(null)

  const show = (sum: Sum) => shown(sum, billing)
  return {
    from: period.from,
    to: period.to,
    billing,
    totals: show(totals),
    products: USAGE_PRODUCT_IDS.map((id) => {
      const own = taskIds.filter((task) => productOfTask(task) === id).map((task) => ({ task, sum: tasks.get(task) ?? zero() }))
      const sum = zero()
      for (const task of own) add(sum, task.sum)
      return { id, label: usageProductLabel(id), ...show(sum), tasks: own.map(({ task, sum }) => ({ id: task, label: taskLabel(task), ...show(sum) })) }
    }),
    people: [...people]
      .map(([userId, p]) => ({
        userId,
        name: p.name,
        kind: p.kind,
        ...show(p.amounts),
        products: USAGE_PRODUCT_IDS.filter((id) => p.products.has(id)).map((id) => ({ id, label: usageProductLabel(id), ...show(p.products.get(id)!) })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)),
    models: [...models]
      .map(([model, amounts]) => ({ model, ...show(amounts) }))
      .sort((a, b) => (a.model === null ? 1 : b.model === null ? -1 : a.model.localeCompare(b.model))),
    daily: [...days]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, day]) => {
        const used = USAGE_PRODUCT_IDS.filter((id) => day.products.has(id))
        const base = { date, costUsd: day.costUsd, products: Object.fromEntries(used.map((id) => [id, day.products.get(id)!])) }
        if (billing === null) return base
        const productsEur = Object.fromEntries(used.map((id) => [id, invoicedEur(day.eigenInference.get(id)!, billing)]))
        let eigenInference = 0
        for (const id of used) eigenInference = usd(eigenInference + day.eigenInference.get(id)!)
        return { ...base, invoicedEur: invoicedEur(eigenInference, billing), productsEur }
      }),
  }
}
