import { readFileSync } from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readAiUsageRows, readFleetAiUsage } from './store'

/**
 * The overview's grouped read and migration 0190's backfill on the test database. Every case
 * runs in a transaction that is rolled back. Needs DATABASE_URL with migrations applied.
 */

const url = process.env.DATABASE_URL?.trim()

class Rollback extends Error {}

describe.skipIf(!url)('AI usage (Postgres)', () => {
  let sql: postgres.Sql
  const tag = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
  const mia = `aiu_mia_${tag}`
  const bot = `aiu_bot_${tag}`

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 1, onnotice: () => {} })
  })
  afterAll(async () => {
    await sql.end()
  })

  async function inRolledBackTx(fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    await expect(
      sql.begin(async (tx) => {
        for (const [id, name, kind] of [
          [mia, 'Mia', 'human'],
          [bot, 'Marketing', 'coworker'],
        ]) {
          await tx`INSERT INTO "user" (id, name, email, kind) VALUES (${id!}, ${name!}, ${`${id}@example.test`}, ${kind!})`
        }
        await fn(tx)
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  const call = (
    tx: postgres.TransactionSql,
    userId: string,
    row: { operation?: string; provider?: string; task?: string | null; model?: string | null; cost?: string; base?: string; at?: string; completion?: number; cached?: number | null },
  ) => tx`
    INSERT INTO activity_call_log (user_id, provider, operation, task, model, base_cost_usd, markup_usd, total_cost_usd, prompt_tokens, completion_tokens, cached_tokens, created_at)
    VALUES (${userId}, ${row.provider ?? 'openrouter'}, ${row.operation ?? 'llm.chat.chat.success(attempt=1)'}, ${row.task ?? null},
            ${row.model ?? null}, ${row.base ?? '0'}, '0', ${row.cost ?? '0.5'}, 100, ${row.completion ?? null}, ${row.cached ?? null},
            ${row.at ?? '2026-11-20T12:00:00Z'}::timestamp)
  `

  it('groups LLM calls by principal, task, model and UTC day, within the period', async () => {
    await inRolledBackTx(async (tx) => {
      await call(tx, mia, { task: 'brain.retrieval_rerank', model: 'm/one' })
      await call(tx, mia, { task: 'brain.retrieval_rerank', model: 'm/one', cost: '0.25', at: '2026-11-20T23:59:59Z' })
      await call(tx, bot, { task: 'coworkers.turn', model: 'm/two', at: '2026-11-21T00:00:00Z' })
      await call(tx, mia, { task: 'brain.retrieval_rerank', at: '2026-11-22T00:00:00Z' })
      // not model calls: tool rows and the graph's
      await call(tx, mia, { provider: 'agent', operation: 'tool_call.x', cost: '0' })
      await call(tx, mia, { provider: 'apache_age', operation: 'cypher', cost: '0' })

      const rows = (await readAiUsageRows(tx, { from: '2026-11-20', to: '2026-11-21' })).filter((r) => r.userId === mia || r.userId === bot)
      expect(rows.sort((a, b) => a.day.localeCompare(b.day))).toEqual([
        { userId: mia, name: 'Mia', kind: 'person', task: 'brain.retrieval_rerank', model: 'm/one', day: '2026-11-20', costUsd: 0.75, calls: 2, promptTokens: 200, completionTokens: 0, cachedTokens: 0, eigenInferenceUsd: 0 },
        { userId: bot, name: 'Marketing', kind: 'coworker', task: 'coworkers.turn', model: 'm/two', day: '2026-11-21', costUsd: 0.5, calls: 1, promptTokens: 100, completionTokens: 0, cachedTokens: 0, eigenInferenceUsd: 0 },
      ])
      const all = (await readAiUsageRows(tx, { from: null, to: null })).filter((r) => r.userId === mia)
      expect(all.reduce((n, r) => n + r.calls, 0)).toBe(3)
    })
  })

  it('each group carries the provider-reported base of its eigenInference calls only (what the hosting invoices from)', async () => {
    await inRolledBackTx(async (tx) => {
      await call(tx, mia, { provider: 'platform', task: 'assistant.turn', model: `m/${tag}`, base: '0.001', cost: '0.0012' })
      await call(tx, mia, { provider: 'openrouter', task: 'assistant.turn', model: `m/${tag}`, base: '0.004', cost: '0.0048' })
      const [group] = (await readAiUsageRows(tx, { from: '2026-11-20', to: '2026-11-20' })).filter((r) => r.model === `m/${tag}`)
      expect(group).toMatchObject({ calls: 2, costUsd: 0.006, eigenInferenceUsd: 0.001 })
    })
  })

  it('the fleet read: eigenInference calls only (provider platform), per UTC day × task × model from a day on, provider-reported base cost', async () => {
    await inRolledBackTx(async (tx) => {
      const m1 = `m/one-${tag}`
      const m2 = `m/two-${tag}`
      // eigenInference: two people, same day/task/model → one row; base cost, never the box's marked-up total
      await call(tx, mia, { provider: 'platform', task: 'assistant.turn', model: m1, base: '0.001', cost: '0.0012', completion: 10, cached: 40, at: '2026-11-20T00:00:00Z' })
      await call(tx, bot, { provider: 'platform', task: 'assistant.turn', model: m1, base: '0.002', cost: '0.0024', completion: 5, at: '2026-11-20T23:59:59Z' })
      await call(tx, mia, { provider: 'platform', task: null, model: m2, base: '0.0005', cost: '0.0006', at: '2026-11-21T08:00:00Z' })
      // before the from day; BYOK and tool rows on the from day
      await call(tx, mia, { provider: 'platform', task: 'assistant.turn', model: m1, base: '9', at: '2026-11-19T23:59:59Z' })
      await call(tx, mia, { provider: 'openrouter', task: 'assistant.turn', model: m1, base: '9', at: '2026-11-20T12:00:00Z' })
      await call(tx, mia, { provider: 'eurouter', task: 'assistant.turn', model: m2, base: '9', at: '2026-11-20T12:00:00Z' })
      await call(tx, mia, { provider: 'agent', operation: 'tool_call.x', model: m1, at: '2026-11-20T12:00:00Z' })

      const rows = (await readFleetAiUsage(tx, '2026-11-20')).filter((r) => r.model === m1 || r.model === m2)
      expect(rows.sort((a, b) => a.day.localeCompare(b.day))).toEqual([
        { day: '2026-11-20', task: 'assistant.turn', model: m1, calls: 2, promptTokens: 200, completionTokens: 15, cachedTokens: 40, costUsd: 0.003 },
        { day: '2026-11-21', task: null, model: m2, calls: 1, promptTokens: 100, completionTokens: 0, cachedTokens: 0, costUsd: 0.0005 },
      ])
    })
  })

  it('migration 0190 attributes older rows by their exact names and leaves the rest alone', async () => {
    const backfill = readFileSync(path.resolve('drizzle/0190_activity_call_task_model.sql'), 'utf8')
      .split('--> statement-breakpoint')
      .filter((chunk) => /^UPDATE "activity_call_log"/m.test(chunk))
    expect(backfill).toHaveLength(3)

    const cases: [string, string, string | null][] = [
      [mia, 'llm.chat.enrich_thought_bundle.success(attempt=1)', 'memory.enrich_thought_bundle'],
      [mia, 'llm.chat.retrieval_rerank.error(attempt=3)', 'brain.retrieval_rerank'],
      [mia, 'llm.chat.compose_answer.cut_short(attempt=2)', 'brain.compose_answer'],
      [mia, 'llm.chat.durable_agent.success(attempt=1)', 'assistant.turn'],
      [bot, 'llm.chat.durable_agent.success(attempt=1)', 'coworkers.turn'],
      [mia, 'llm.stt.success(attempt=1,model=qwen/qwen3-asr-1.7b)', 'speech.stt'],
      [mia, 'llm.tts.error(attempt=2,model=qwen/tts)', 'speech.tts'],
      [mia, 'llm.decide.success(attempt=1,model=typesafe/jev-1.13)', 'decisions.judge'],
      [mia, 'llm.chat.provider-test.success', 'setup.provider_test'],
      [mia, 'llm.chat.chat.success(attempt=1)', null],
      [mia, 'llm.chat.agent_iter_0.success(attempt=1)', null],
      [mia, 'llm.embedding.success(attempt=1)', null],
      [mia, 'llm.chat.enrich_thought_bundle_v2.success(attempt=1)', null],
    ]
    await inRolledBackTx(async (tx) => {
      for (const [userId, operation] of cases) await call(tx, userId, { operation })
      for (const statement of backfill) await tx.unsafe(statement)
      for (const [userId, operation, task] of cases) {
        const [row] = await tx<{ task: string | null }[]>`SELECT task FROM activity_call_log WHERE user_id = ${userId} AND operation = ${operation}`
        expect(row?.task ?? null, operation).toBe(task)
      }
    })
  })
})
