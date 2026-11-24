import type { CoworkerView } from './service'
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { appDbAsyncLocal, type AppDatabase } from '$lib/server/db/context'
import { decideMany } from '$lib/server/decisions/decide'
import { decisionsPort } from '$lib/server/decisions/service'
import { liveDecisionStore } from '$lib/server/decisions/store'
import { liveLlmDecideDeps, llmDecide, type LlmDecideDeps } from '$lib/server/llm/llm-decide'
import { coworkerEventMine } from '../../../../modules/coworkers/decision-kinds'
import { DECISION_KINDS } from '../../../../modules/decision-kinds'
import { mockDecision } from '../../../../scripts/mock-gateway-decisions.mjs'
import { dbCoworkerEventStores } from './db-event-store'
import { CoworkerEventRouter, type ChannelMessageEvent } from './events'

/**
 * C7, routed once, on the test database with the mock gateway's decision endpoint on a real
 * HTTP port: the subscription, one coworker_event_route per event across two routers (two app
 * processes), one coworker_event_observation per co-worker linked to it, the shadow decisions
 * in decision_log with the one call's cost row on the message's author, a capped co-worker
 * counted, and an admin's label counted as agreement. Every case runs in a transaction that is
 * rolled back. Needs DATABASE_URL with migrations applied (0177).
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
  const cw2 = `c7_cw2_${tag}`
  const admin = `c7_admin_${tag}`
  // Event ids are unique per kind in coworker_event_route: tagged, like the users.
  const m1 = `m1_${tag}`
  const m2 = `m2_${tag}`

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
            `insert into "user" (id, name, email, email_verified, onboarding_completed, role, kind) values ('${cw}', 'Marketing', '${cw}@coworker.invalid', true, true, 'member', 'coworker'), ('${cw2}', 'GTM', '${cw2}@coworker.invalid', true, true, 'member', 'coworker'), ('${admin}', 'Ari Admin', '${admin}@test.local', true, true, 'admin', 'human')`,
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

  const gtm: CoworkerView = { ...view, id: cw2, name: 'GTM', email: `${cw2}@coworker.invalid`, slug: 'gtm', title: 'GTM Lead', accountabilities: ['Pricing'], agentId: `coworker-${cw2}` }

  function router(tx: AppDatabase, spent: Record<string, number> = {}) {
    const stores = dbCoworkerEventStores(async () => tx)
    // conversation_id references message_conversations; these events name none that exists, so the spec stores null.
    const observations: typeof stores = { ...stores, claimRoute: (i) => stores.claimRoute({ ...i, conversationId: null }) }
    return {
      stores,
      router: new CoworkerEventRouter({
        kind: coworkerEventMine,
        subscriptions: stores,
        observations,
        coworkers: { listEnabled: async () => [view, gtm] },
        spentToday: async (id) => spent[id] ?? 0,
        authorCapRefusal: async () => null,
        decideMany: (k, items, o) => decideMany(k, items, o, { ask: (i) => llmDecide(i, gateway()), store: liveDecisionStore }),
        queueRun: async () => {
          throw new Error('a shadow kind never queues a run')
        },
      }),
    }
  }

  it('switched on, routed once across two processes: one call billed to the author, one decision and observation per co-worker; an admin label counts', async () => {
    await inRolledBackTx(async (tx) => {
      const a = router(tx)
      const b = router(tx)
      expect(await a.router.listening('channel_message')).toEqual([])
      await a.stores.set(cw, ['channel_message'], admin, new Date())
      await a.stores.set(cw2, ['channel_message'], admin, new Date())
      expect(await b.stores.subscribers('channel_message')).toEqual([cw, cw2].sort())
      expect((await b.router.listening('channel_message')).map((v) => v.id)).toEqual([cw, cw2])

      const body = 'Draft the launch post. [mock-decide:q0=yes@0.81] [mock-decide:q1=no@0.7]'
      const first = await a.router.route(event(m1, body), [view, gtm])
      expect(first).toMatchObject({ outcome: 'decided', coworkers: { [cw]: { outcome: 'observed', runId: null }, [cw2]: { outcome: 'observed' } } })
      expect(await b.router.route(event(m1, body), [view, gtm])).toEqual({ outcome: 'duplicate' })

      const routes = (await tx.execute(
        `select id, event_id, author_user_id, outcome, candidates, questions from coworker_event_route where author_user_id = '${admin}'`,
      )) as unknown as Array<Record<string, unknown>>
      expect(routes).toEqual([{ id: expect.any(String), event_id: m1, author_user_id: admin, outcome: 'decided', candidates: 2, questions: 2 }])
      const rows = (await tx.execute(
        `select coworker_user_id, event_id, outcome, decision_id, route_id from coworker_event_observation where event_id = '${m1}' and coworker_user_id in ('${cw}', '${cw2}') order by coworker_user_id`,
      )) as unknown as Array<Record<string, string>>
      const results = (first as { coworkers: Record<string, { decisionId: string }> }).coworkers
      expect(rows).toEqual(
        [cw, cw2].sort().map((id) => ({ coworker_user_id: id, event_id: m1, outcome: 'observed', decision_id: results[id]!.decisionId, route_id: routes[0]!.id })),
      )

      const [logged] = await liveDecisionStore.recent({ kind: 'coworkers.event_mine', subjectUserId: cw, readerId: null, limit: 10 })
      expect(logged).toMatchObject({ status: 'shadow', outcome: 'observed', jevChoice: 'yes', jevConfidence: 0.81, requestedBy: admin, usedChoice: null })
      expect(logged!.input).toMatchObject({ coworkerUserId: cw, eventId: m1, channel: 'launch' })
      const [other] = await liveDecisionStore.recent({ kind: 'coworkers.event_mine', subjectUserId: cw2, readerId: null, limit: 10 })
      expect(other).toMatchObject({ jevChoice: 'no', requestedBy: admin })

      // One call, on the author; nothing on the co-workers.
      const cost = (await tx.execute(
        `select user_id, count(*)::int as n from activity_call_log where user_id in ('${admin}', '${cw}', '${cw2}') group by user_id`,
      )) as unknown as Array<{ user_id: string; n: number }>
      expect(cost).toEqual([{ user_id: admin, n: 1 }])

      const port = decisionsPort(liveDecisionStore, DECISION_KINDS)
      await port.label(admin, logged!.id, 'no')
      expect(await liveDecisionStore.get(logged!.id)).toMatchObject({ humanChoice: 'no', labelledBy: admin, usedChoice: null })
      const mine = await port.log({ kind: 'coworkers.event_mine', subjectUserId: cw, limit: 5, readerId: null })
      expect(mine.map((r) => [r.jevChoice, r.humanChoice])).toEqual([['yes', 'no']])
    })
  })

  it('a co-worker with a spent daily cap is counted and left out; the route records how many were asked', async () => {
    await inRolledBackTx(async (tx) => {
      const { stores, router: r } = router(tx, { [cw]: 5 })
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(await r.route(event(m2, 'What is the price?'), [view, gtm])).toMatchObject({ outcome: 'decided', coworkers: { [cw]: { outcome: 'skipped_daily_cap' }, [cw2]: { outcome: 'observed' } } })
      error.mockRestore()
      expect(await stores.counts(cw, new Date(Date.now() - 3_600_000))).toMatchObject({ skipped_daily_cap: 1, observed: 0 })
      expect(await stores.counts(cw2, new Date(Date.now() - 3_600_000))).toMatchObject({ observed: 1 })
      const routes = (await tx.execute(`select candidates, questions from coworker_event_route where event_id = '${m2}' and author_user_id = '${admin}'`)) as unknown as Array<Record<string, number>>
      expect(routes).toEqual([{ candidates: 2, questions: 1 }])
      expect(await liveDecisionStore.recent({ kind: 'coworkers.event_mine', subjectUserId: cw, readerId: null, limit: 10 })).toHaveLength(0)
      await stores.set(cw, [], admin, new Date())
      expect(await stores.list(cw)).toEqual([])
    })
  })
})
