import type { CoworkerView } from './service'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appDbAsyncLocal, type AppDatabase } from '$lib/server/db/context'
import { decide } from '$lib/server/decisions/decide'
import { decisionsPort } from '$lib/server/decisions/service'
import { liveDecisionStore } from '$lib/server/decisions/store'
import { liveLlmDecideDeps, llmDecide, type LlmDecideDeps } from '$lib/server/llm/llm-decide'
import { coworkerEventMine } from '../../../../modules/coworkers/decision-kinds'
import { DECISION_KINDS } from '../../../../modules/decision-kinds'
import { mockDecision } from '../../../../scripts/mock-gateway-decisions.mjs'
import { dbCoworkerEventStores } from './db-event-store'
import { CoworkerEventObserver, type ChannelMessageEvent } from './events'

/**
 * C7 on the test database, with the mock gateway's decision endpoint on a real HTTP port:
 * the subscription, one coworker_event_observation per co-worker and event across two
 * observers (two app processes), the shadow decision in decision_log with its cost row on
 * the co-worker, the hourly limit counted in Postgres, and an admin's label counted as
 * agreement. Every case runs in a transaction that is rolled back. Needs DATABASE_URL with
 * migrations applied (0176).
 */

const url = process.env.DATABASE_URL?.trim()

class Rollback extends Error {}

describe.skipIf(!url)('co-worker event reactions (Postgres) + Jev on the mock decision endpoint', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  let server: http.Server
  let base: string
  const tag = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`
  const cw = `c7_cw_${tag}`
  const admin = `c7_admin_${tag}`

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
          await handle.execute(
            `insert into "user" (id, name, email, email_verified, onboarding_completed, role, kind) values ('${cw}', 'Marketing', '${cw}@coworker.invalid', true, true, 'member', 'coworker'), ('${admin}', 'Ari Admin', '${admin}@test.local', true, true, 'admin', 'human')`,
          )
          await fn(handle)
        })
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  const view: CoworkerView = {
    id: cw,
    name: 'Marketing',
    email: `${cw}@coworker.invalid`,
    slug: 'marketing',
    title: 'Marketing Manager',
    accountabilities: ['Launch communication'],
    lens: 'On brand, on time.',
    modelId: 'anthropic/claude-sonnet-5.5',
    enabled: true,
    dailyCapUsd: 2,
    templateId: null,
    reportsToUserId: admin,
    accountableHuman: { id: admin, name: 'Ari Admin', reason: 'chain' },
    agentId: `coworker-${cw}`,
    createdBy: admin,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    removedAt: null,
  }

  const event = (id: string, body: string): ChannelMessageEvent => ({
    kind: 'channel_message',
    id,
    conversationId: '00000000-0000-4000-8000-0000000000c7',
    channelName: 'launch',
    privateChannel: false,
    threadRootId: id,
    isReply: false,
    authorId: admin,
    authorName: 'Ari Admin',
    body,
    at: '2026-11-23T09:00:00.000Z',
  })

  function observer(tx: AppDatabase, hourlyLimit = 20) {
    const stores = dbCoworkerEventStores(async () => tx)
    // conversation_id references message_conversations; these events name none that exists, so the spec stores null.
    const observations: typeof stores = { ...stores, claim: (i) => stores.claim({ ...i, conversationId: null }) }
    return {
      stores,
      observer: new CoworkerEventObserver({
        kind: coworkerEventMine,
        subscriptions: stores,
        observations,
        coworkers: { get: async () => view },
        spentToday: async () => 0,
        decide: (k, input, o) => decide(k, input, o, { ask: (i) => llmDecide(i, gateway()), store: liveDecisionStore }),
        queueRun: async () => {
          throw new Error('a shadow kind never queues a run')
        },
        hourlyLimit,
      }),
    }
  }

  it('switched on, one shadow decision per event across two processes; the cost row is the co-worker’s; an admin label counts', async () => {
    await inRolledBackTx(async (tx) => {
      const a = observer(tx)
      const b = observer(tx)
      expect(await a.observer.observe(cw, event('m1', 'Draft the launch post.'))).toEqual({ outcome: 'not_subscribed' })
      await a.stores.set(cw, ['channel_message'], admin, new Date())
      expect(await b.stores.list(cw)).toEqual(['channel_message'])

      const first = await a.observer.observe(cw, event('m1', 'Draft the launch post. [mock-decide:decision=yes@0.81]'))
      expect(first).toMatchObject({ outcome: 'observed', runId: null })
      expect(await b.observer.observe(cw, event('m1', 'Draft the launch post. [mock-decide:decision=yes@0.81]'))).toEqual({ outcome: 'duplicate' })

      const rows = (await tx.execute(
        `select event_id, outcome, decision_id from coworker_event_observation where coworker_user_id = '${cw}'`,
      )) as unknown as Array<Record<string, string>>
      expect(rows).toEqual([{ event_id: 'm1', outcome: 'observed', decision_id: (first as { decisionId: string }).decisionId }])

      const [logged] = await liveDecisionStore.recent({ kind: 'coworkers.event_mine', subjectUserId: cw, readerId: null, limit: 10 })
      expect(logged).toMatchObject({ status: 'shadow', outcome: 'observed', jevChoice: 'yes', jevConfidence: 0.81, requestedBy: cw, usedChoice: null })
      expect(logged!.input).toMatchObject({ coworkerUserId: cw, eventId: 'm1', channel: 'launch', excerpt: 'Draft the launch post. [mock-decide:decision=yes@0.81]' })

      const cost = (await tx.execute(`select count(*)::int as n from activity_call_log where user_id = '${cw}'`)) as unknown as Array<{ n: number }>
      expect(cost[0]!.n).toBe(1)

      const port = decisionsPort(liveDecisionStore, DECISION_KINDS)
      await port.label(admin, logged!.id, 'no')
      expect(await liveDecisionStore.get(logged!.id)).toMatchObject({ humanChoice: 'no', labelledBy: admin, usedChoice: null })
      const mine = await port.log({ kind: 'coworkers.event_mine', subjectUserId: cw, limit: 5, readerId: null })
      expect(mine.map((r) => [r.jevChoice, r.humanChoice])).toEqual([['yes', 'no']])
    })
  })

  it('the hourly limit holds in Postgres and the skip is counted', async () => {
    await inRolledBackTx(async (tx) => {
      const { stores, observer: o } = observer(tx, 1)
      await stores.set(cw, ['channel_message'], admin, new Date())
      expect(await o.observe(cw, event('m1', 'one'))).toMatchObject({ outcome: 'observed' })
      expect(await o.observe(cw, event('m2', 'two'))).toMatchObject({ outcome: 'skipped_rate_limit', decisionId: null })
      expect(await stores.counts(cw, new Date(Date.now() - 3_600_000))).toMatchObject({ observed: 1, skipped_rate_limit: 1 })
      const logged = await liveDecisionStore.recent({ kind: 'coworkers.event_mine', subjectUserId: cw, readerId: null, limit: 10 })
      expect(logged).toHaveLength(1)
      await stores.set(cw, [], admin, new Date())
      expect(await stores.list(cw)).toEqual([])
    })
  })
})
