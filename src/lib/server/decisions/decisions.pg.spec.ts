import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mockDecision } from '../../../../scripts/mock-gateway-decisions.mjs'
import { appDbAsyncLocal, type AppDatabase } from '$lib/server/db/context'
import { liveLlmDecideDeps, llmDecide, type LlmDecideDeps } from '$lib/server/llm/llm-decide'
import { decide } from './decide'
import { decisionKindCatalog, defineDecisionKind } from './kind'
import { decisionsPort } from './service'
import { countRows, liveDecisionStore } from './store'

/**
 * CB2 on the test database, with the mock gateway's decision endpoint on a real HTTP port:
 * llmDecide writes its cost row on the acting user, decide() writes decision_log rows, the
 * agreement query, a person answering their question, and who reads which rows. Every case
 * runs in a transaction that is rolled back. Needs DATABASE_URL with migrations applied.
 */

const url = process.env.DATABASE_URL?.trim()

class Rollback extends Error {}

describe.skipIf(!url)('decision log (Postgres) + llmDecide against the mock decision endpoint', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  let server: http.Server
  let base: string
  const tag = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
  const anna = `cb2_anna_${tag}`
  const owner = `cb2_owner_${tag}`
  const kindId = `demo.k_${tag}`

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const { status, body } = req.url === '/alpha/decisions' ? mockDecision(JSON.parse(raw)) : { status: 404, body: {} }
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await sql.end()
  })

  const gateway = (): LlmDecideDeps => ({
    ...liveLlmDecideDeps,
    resolve: async () => ({
      slot: 'decision',
      source: 'eigeninference',
      model: 'typesafe/jev-1.13',
      config: { provider: 'platform', baseUrl: base, apiKey: 'mock', ruleChat: null, ruleEmbedding: null, modelChat: null, modelEmbedding: null },
    }),
  })

  async function inRolledBackTx(fn: (tx: AppDatabase) => Promise<void>): Promise<void> {
    await expect(
      db.transaction(async (tx) => {
        const handle = tx as unknown as AppDatabase
        await appDbAsyncLocal.run(handle, async () => {
          for (const [id, role] of [
            [anna, 'member'],
            [owner, 'admin'],
          ]) {
            await handle.execute(
              `insert into "user" (id, name, email, email_verified, onboarding_completed, role) values ('${id}', '${id}', '${id}@test.local', true, true, '${role}')`,
            )
          }
          await fn(handle)
        })
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  const shadow = defineDecisionKind<{ text: string }, 'yes' | 'no'>({
    id: kindId,
    module: 'demo',
    title: 'Mine?',
    instructions: 'Is this mine to act on?',
    choices: ['yes', 'no'],
    criteria: { yes: 'It is.', no: 'It is not.' },
    status: 'shadow',
    lowConfidence: 0,
    state: (i) => i.text,
    logInput: (i) => ({ length: i.text.length }),
  })
  const enforced = defineDecisionKind<{ text: string }, 'yes' | 'no'>({
    ...shadow,
    id: `${kindId}_enforced`,
    status: 'enforced',
    lowConfidence: 0.7,
    ask: { who: () => owner, question: () => 'Is it yours?', labels: { yes: 'Yes', no: 'No' } },
  })
  const catalog = decisionKindCatalog([shadow, enforced])

  it('llmDecide: one cost row on the acting user, provider-reported cost, no state in the context', async () => {
    await inRolledBackTx(async (tx) => {
      const out = await llmDecide(
        { userId: anna, state: 'PRIVATE mail text', questions: { decision: { instructions: 'Mine?', criteria: shadow.criteria } }, logContext: kindId },
        gateway(),
      )
      expect(out.answers.decision).toMatchObject({ choice: 'yes', confidence: 1 })
      const rows = (await tx.execute(
        `select user_id, provider, operation, base_cost_usd, gateway_host, context from activity_call_log where user_id in ('${anna}', '${owner}')`,
      )) as unknown as Array<Record<string, string>>
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ user_id: anna, provider: 'platform', gateway_host: '127.0.0.1', operation: 'llm.decide.success(attempt=1,model=typesafe/jev-1.13)' })
      expect(Number(rows[0]!.base_cost_usd)).toBeCloseTo(0.000014)
      expect(rows[0]!.context).not.toContain('PRIVATE')
    })
  })

  it('decide in shadow writes the row; agreement and the log are read back from Postgres', async () => {
    await inRolledBackTx(async () => {
      const deps = { ask: (input: Parameters<typeof llmDecide>[0]) => llmDecide(input, gateway()), store: liveDecisionStore }
      const agreed = await decide(shadow, { text: 'a' }, { requestedBy: anna, judge: { current: async () => 'yes' } }, deps)
      expect(agreed).toMatchObject({ outcome: 'decided', choice: 'yes', source: 'current_judge' })
      await decide(shadow, { text: 'b [mock-decide:decision=no@0.8]' }, { requestedBy: anna, judge: { current: async () => 'yes' } }, deps)
      const observed = await decide(shadow, { text: 'c' }, { requestedBy: owner, subjectUserId: owner, judge: { none: true } }, deps)
      expect(observed).toMatchObject({ outcome: 'observed', act: false })

      const stored = await liveDecisionStore.get(agreed.decisionId)
      expect(stored).toMatchObject({ kind: kindId, status: 'shadow', jevChoice: 'yes', judgeChoice: 'yes', input: { length: 1 }, requestedBy: anna })
      expect(stored!.costUsd).toBeCloseTo(0.000014)

      const counts = (await liveDecisionStore.kindCounts()).find((c) => c.kind === kindId)!
      expect(counts).toMatchObject({ total: 3, judgeCompared: 2, judgeAgreed: 1, compared: 2, agreed: 1, jevErrors: 0, openQuestions: 0 })
      // The SQL and the in-memory rules agree.
      const all = await liveDecisionStore.recent({ kind: kindId, readerId: null, limit: 10 })
      expect(countRows(kindId, all)).toEqual({ ...counts, costUsd: expect.closeTo(counts.costUsd, 8) })

      const port = decisionsPort(liveDecisionStore, catalog)
      expect((await port.kinds()).find((k) => k.id === kindId)).toMatchObject({ agreement: 0.5, status: 'shadow', declared: true })
      expect((await port.log({ kind: kindId, limit: 10, readerId: anna })).map((r) => r.input)).toEqual([{ length: 31 }, { length: 1 }])
      expect((await port.log({ kind: kindId, limit: 10, readerId: owner })).map((r) => r.outcome)).toEqual(['observed'])
      expect(await port.log({ kind: kindId, limit: 10, readerId: null })).toHaveLength(3)
    })
  })

  it('an enforced, unsure decision becomes the owner’s question; their answer is the human label and the re-ask returns it', async () => {
    await inRolledBackTx(async () => {
      const deps = { ask: (input: Parameters<typeof llmDecide>[0]) => llmDecide(input, gateway()), store: liveDecisionStore }
      const input = { text: 'share this? [mock-decide:decision=yes@0.55]' }
      const pending = await decide(enforced, input, { requestedBy: anna, judge: { none: true } }, deps)
      expect(pending).toMatchObject({ outcome: 'pending', pending: true })
      const port = decisionsPort(liveDecisionStore, catalog)
      expect((await port.questions(owner)).map((q) => [q.id, q.question])).toEqual([[pending.decisionId, 'Is it yours?']])
      expect(await port.questions(anna)).toEqual([])
      await expect(port.answer(anna, pending.decisionId, 'no')).rejects.toThrow(/no decision question/)
      await port.answer(owner, pending.decisionId, 'no')
      expect(await port.questions(owner)).toEqual([])
      expect(await liveDecisionStore.get(pending.decisionId)).toMatchObject({ humanChoice: 'no', labelledBy: owner, usedSource: 'human' })
      const answered = await decide(enforced, input, { requestedBy: anna, judge: { none: true } }, deps)
      expect(answered).toMatchObject({ outcome: 'decided', choice: 'no', source: 'human', decisionId: pending.decisionId })
      expect((await port.kinds()).find((k) => k.id === enforced.id)).toMatchObject({ humanCompared: 1, humanAgreed: 0, agreement: 0 })
    })
  })
})
