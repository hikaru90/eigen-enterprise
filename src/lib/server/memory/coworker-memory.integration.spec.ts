import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { coworkerPrincipal, delegatedPrincipal } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext } from '$lib/kernel/types'
import type { CoworkerActor, CoworkerView } from '$lib/server/coworkers/service'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'
import { createMemoryTools } from '../../../../modules/memory/tools'
import { ORCHESTRATOR_AGENT_ID } from '../../../../modules/orchestrator/brain'

// Memory documents are Drive files (drizzle/0191): the live Drive keeps their bytes here.
process.env.DRIVE_STORAGE_DIR ??= mkdtempSync(join(tmpdir(), 'ee-memory-drive-'))

/**
 * AI co-workers in Memory (plan/phase-ai-coworkers.md §3, §7, C4) on the test
 * database, as the app's RLS role: a co-worker captures and retrieves thoughts
 * as itself; its thoughts are company-visible, sealed with the company key and
 * read-only to everyone else; a person's private thoughts reach no one else —
 * no co-worker, no colleague. Enrichment of a co-worker's thought runs in its
 * own queue, on its own cost.
 *
 * The model calls are stubbed at their seams (embedding, rerank, the enrich
 * bundle and graph step), so this runs without a gateway; every SQL path,
 * row-level security, key and queue is real.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

const { scheduleWorker, embedCalls, queryVector } = vi.hoisted(() => {
  // One-hot vector at a run-specific index: this run's rows are distance 0, other data is not.
  const index = Math.floor(Math.random() * 1536)
  const vector = Array.from({ length: 1536 }, (_, i) => (i === index ? 1 : 0))
  return { scheduleWorker: vi.fn(), embedCalls: [] as string[], queryVector: vector }
})

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: scheduleWorker,
}))
vi.mock('$lib/server/llm/embedding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/llm/embedding')>()),
  createThoughtEmbedding: vi.fn(async (userId: string) => {
    embedCalls.push(userId)
    return queryVector
  }),
}))
vi.mock('$lib/server/retrieval/reranker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/retrieval/reranker')>()),
  shouldSkipRerank: () => true,
}))
vi.mock('$lib/server/capture/split-capture-content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/capture/split-capture-content')>()),
  resolveCaptureContentSplit: vi.fn(async (input: { rawText: string }) => ({ mode: 'thought_only', thoughtText: input.rawText })),
}))
vi.mock('$lib/server/memory/entity-graph-enrichment-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/memory/entity-graph-enrichment-context')>()),
  loadEntityGraphEnrichmentContext: vi.fn(async () => undefined),
}))
vi.mock('$lib/server/capture/enrich-thought-bundle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/capture/enrich-thought-bundle')>()),
  extractEnrichThoughtBundle: vi.fn(
    async (input: { context: { ontology: { entityKindsByKey: Map<string, { id: string }> } } }) => ({
      category: {
        key: 'observation',
        ontologyEntityKindId: input.context.ontology.entityKindsByKey.get('observation')!.id,
        confidence: 0.9,
        alternatives: [],
      },
      cues: [],
      temporalMentions: [],
      entityGraph: { mentions: [], triples: [] },
    }),
  ),
}))
vi.mock('$lib/server/capture/enrich', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/capture/enrich')>()),
  // The graph step (entities, relations) is the owner's own graph; here it only marks the row enriched.
  enrichThought: vi.fn(async (_userId: string, thoughtId: string) => {
    const { getDb } = await import('$lib/server/db')
    const { thought } = await import('$lib/server/db/schema')
    await getDb().update(thought).set({ enrichedAt: new Date() }).where(eq(thought.id, thoughtId))
  }),
}))

type Owner = { id: string; name: string; kind: string }
type Hit = { id: string; snippet?: string; normalizedText?: string; owner: Owner; editable: boolean; author?: string; authorLabel?: string }
type Retrieved = { count: number; results: Hit[] }

const keyOf = (ciphertext: string | null): string => (JSON.parse(ciphertext ?? '{}') as { k?: string }).k ?? 'person'

describe.skipIf(!DATABASE_URL)('AI co-workers in Memory', () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`
  // Distinctive lexical tokens (alphanumeric, ≥ 3 chars) so search finds exactly this run's rows.
  const campaignWord = `webinar${tag}`
  const secretWord = `resign${tag}`
  const ana = `cwm_ana_${tag}`
  const ben = `cwm_ben_${tag}`
  const boss = `cwm_admin_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')
  let mara: CoworkerView
  let gus: CoworkerView
  let maraThought: string
  let anaPrivate: string
  let benPrivate: string
  const admin: CoworkerActor = { id: boss, role: 'admin', kind: 'person' }

  const registry = new KernelRegistry({ principalScope: livePrincipalScope })
  for (const tool of createMemoryTools()) registry.register(tool)
  const human = (id: string): ToolContext => ({ principal: { id, kind: 'human', roles: ['member'] }, requestId: `r-${id}` })
  const brainFor = (id: string): ToolContext => ({
    principal: delegatedPrincipal({ id, roles: ['member'] }, ORCHESTRATOR_AGENT_ID),
    requestId: `rb-${id}`,
  })
  const asCoworker = (cw: CoworkerView): ToolContext => ({ principal: coworkerPrincipal(cw.id, cw.agentId), requestId: `rc-${cw.id}` })
  const retrieve = (ctx: ToolContext, input: Record<string, unknown>) =>
    registry.execute('memory.retrieve_thoughts', input, ctx) as Promise<Retrieved>
  const ids = (out: Retrieved) => out.results.map((r) => r.id)

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const [id, role] of [
      [ana, 'member'],
      [ben, 'member'],
      [boss, 'admin'],
    ] as const) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${`${role} ${id.slice(4, 7)}`}, ${`${id}@test.local`}, true, true, ${role})`
    }
    const svc = await import('$lib/server/coworkers')
    mara = await svc.createCoworker(admin, { templateId: 'marketing-manager', name: `Mara ${tag}` }, svc.coworkerDeps())
    gus = await svc.createCoworker(admin, { templateId: 'go-to-market-manager', name: `Gus ${tag}` }, svc.coworkerDeps())

    const { queueCapture } = await import('$lib/server/capture/queue-capture')
    anaPrivate = await db.withDbUser(ana, async () =>
      (await queueCapture(ana, `I am thinking about whether to ${secretWord} next spring`, { skipWorker: true })).thoughtId,
    )
    benPrivate = await db.withDbUser(ben, async () =>
      (await queueCapture(ben, `My own ${secretWord} plan stays with me`, { skipWorker: true })).thoughtId,
    )
    // Cold imports of Memory and Drive (documents are Drive files) outlast the 10s default.
  }, 30_000)

  afterAll(async () => {
    await operator`delete from "user" where id in ${operator([ana, ben, boss, ...[mara, gus].filter(Boolean).map((c) => c.id)])}`
    await operator.end()
    await db.closeAppDbPool()
  })

  /** Give this run's rows the query's embedding, so the vector path reaches them too (not only the lexical one). */
  const embedRows = async (thoughtIds: string[]) => {
    const literal = `[${queryVector.join(',')}]`
    await operator`update thought set embedding = ${literal}::vector where id in ${operator(thoughtIds)}`
  }

  it('a co-worker captures a thought as itself: its own row, written by it, company-sealed, queued for its own enrichment', async () => {
    const out = (await registry.execute(
      'memory.capture_thought',
      { raw: `Campaign idea: a launch ${campaignWord} for the spring release` },
      asCoworker(mara),
    )) as { thoughtId: string; status: string }
    maraThought = out.thoughtId
    expect(out.status).toBe('pending')
    const [row] = await operator`
      select user_id, author, author_label, author_key_id, capture_source,
             raw_text_encrypted, normalized_text_encrypted, metadata_encrypted
      from thought where id = ${maraThought}`
    expect(row).toMatchObject({ user_id: mara.id, author: 'agent', author_label: mara.name, author_key_id: null, capture_source: 'agent' })
    expect([row!.raw_text_encrypted, row!.normalized_text_encrypted, row!.metadata_encrypted].map(keyOf)).toEqual([
      'company',
      'company',
      'company',
    ])
    expect(scheduleWorker).toHaveBeenCalledWith(mara.id)
    await embedRows([maraThought, anaPrivate, benPrivate])
  })

  it('a co-worker cannot write under another name or make its work private', async () => {
    await expect(
      registry.execute('memory.capture_thought', { raw: 'as someone else', as_user: true }, asCoworker(mara)),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(
      registry.execute('memory.create_text_file', { title: 'Hidden', body: 'x', private: true }, asCoworker(mara)),
    ).rejects.toMatchObject({ code: 'permission_denied' })
    await expect(
      registry.execute('memory.set_text_file_visibility', { text_file_id: 'x', private: true }, asCoworker(mara)),
    ).rejects.toMatchObject({ code: 'permission_denied' })
  })

  it('it finds its own thought, browsing and searching, as its own (editable)', async () => {
    const browsed = await retrieve(asCoworker(mara), { order: 'created_at', scope: 'mine', top_k: 20 })
    expect(ids(browsed)).toContain(maraThought)
    const searched = await retrieve(asCoworker(mara), { query: `launch ${campaignWord}` })
    const hit = searched.results.find((r) => r.id === maraThought)
    expect(hit).toMatchObject({ owner: { id: mara.id, name: mara.name, kind: 'coworker' }, editable: true, author: 'agent' })
    expect(hit!.snippet).toContain(campaignWord)
    // The query was embedded on the co-worker's own id: its cost is its own.
    expect(embedCalls).toContain(mara.id)
  })

  it('a person finds it read-only with the co-worker as owner — directly and through the brain', async () => {
    for (const ctx of [human(ana), brainFor(ana)]) {
      const searched = await retrieve(ctx, { query: `launch ${campaignWord}` })
      const hit = searched.results.find((r) => r.id === maraThought)
      expect(hit).toMatchObject({ owner: { id: mara.id, name: mara.name, kind: 'coworker' }, editable: false })
      expect(hit!.snippet).toContain(campaignWord)
      const browsed = await retrieve(ctx, { order: 'created_at', top_k: 100 })
      expect(ids(browsed)).toContain(maraThought)
      // scope 'mine' is the person's own Memory only.
      expect(ids(await retrieve(ctx, { query: `launch ${campaignWord}`, scope: 'mine' }))).not.toContain(maraThought)
    }
    // Another co-worker reads it too (detail full carries the text).
    const full = await retrieve(asCoworker(gus), { query: `launch ${campaignWord}`, scope: 'team', detail: 'full' })
    const hit = full.results.find((r) => r.id === maraThought)
    expect(hit).toMatchObject({ owner: { id: mara.id, kind: 'coworker' }, editable: false })
    expect(hit!.normalizedText).toContain(campaignWord)
  })

  it('nobody but the co-worker changes it: not a person, not another co-worker, not even in SQL', async () => {
    const before = await operator`select normalized_text_encrypted, lifecycle_status from thought where id = ${maraThought}`
    await expect(
      registry.execute('memory.edit_thought', { thought_id: maraThought, change: 'make it a podcast' }, human(ana)),
    ).rejects.toThrow()
    for (const [name, input] of [
      ['memory.edit_thought', { thought_id: maraThought, change: 'make it a podcast' }],
      ['memory.set_thought_status', { thought_id: maraThought, status: 'archived' }],
      ['memory.delete_thought', { thought_id: maraThought }],
    ] as const) {
      await expect(registry.execute(name, input, asCoworker(gus))).rejects.toThrow()
    }
    const updated = await db.withDbUser(ana, (scoped) =>
      scoped.execute(sql`update thought set lifecycle_status = 'archived' where id = ${maraThought} returning id`),
    )
    expect([...updated]).toHaveLength(0)
    const deleted = await db.withDbUser(gus.id, (scoped) =>
      scoped.execute(sql`delete from thought where id = ${maraThought} returning id`),
    )
    expect([...deleted]).toHaveLength(0)
    expect(await operator`select normalized_text_encrypted, lifecycle_status from thought where id = ${maraThought}`).toEqual(before)
  })

  it('a co-worker never finds a person’s private thought, and neither does another person', async () => {
    for (const ctx of [asCoworker(mara), asCoworker(gus), human(ben), brainFor(ben)]) {
      for (const scope of ['all', 'team', 'mine']) {
        const searched = await retrieve(ctx, { query: `whether to ${secretWord}`, scope, author: 'all', detail: 'full' })
        expect(ids(searched)).not.toContain(anaPrivate)
        const browsed = await retrieve(ctx, { order: 'created_at', scope, author: 'all', top_k: 100 })
        expect(ids(browsed)).not.toContain(anaPrivate)
      }
    }
    // Ana sees her own, never Ben's; Ben sees his own, never Ana's.
    const anaSearch = await retrieve(human(ana), { query: `whether to ${secretWord}` })
    expect(ids(anaSearch)).toContain(anaPrivate)
    expect(ids(anaSearch)).not.toContain(benPrivate)
    expect(anaSearch.results.find((r) => r.id === anaPrivate)).toMatchObject({ owner: { id: ana, kind: 'human' }, editable: true })
    // And underneath, the co-worker's session cannot see the row at all.
    const seen = await db.withDbUser(mara.id, (scoped) =>
      scoped.execute(sql`select count(*)::int as n from thought where id in (${anaPrivate}, ${benPrivate})`),
    )
    expect(([...seen][0] as { n: number }).n).toBe(0)
  })

  it('enrichment runs for a co-worker’s thought in its own queue, on its own cost, and keeps it company-sealed', async () => {
    embedCalls.length = 0
    const { drainCaptureEnrichQueue } = await import('$lib/server/capture/enrich-queue-drain')
    const processed = await db.withDbUser(mara.id, () =>
      drainCaptureEnrichQueue(mara.id, { concurrency: 1, idlePollMs: 5, idleRoundsBeforeExit: 1 }),
    )
    expect(processed).toBeGreaterThanOrEqual(1)
    const [row] = await operator`
      select enrich_queue_status, enriched_at, embedding is not null as embedded,
             normalized_text_encrypted, metadata_encrypted
      from thought where id = ${maraThought}`
    expect(row).toMatchObject({ enrich_queue_status: 'complete', embedded: true })
    expect(row!.enriched_at).not.toBeNull()
    // Tier 2 rewrote the metadata with the default key: a co-worker's stays the company key.
    expect([row!.normalized_text_encrypted, row!.metadata_encrypted].map(keyOf)).toEqual(['company', 'company'])
    expect(embedCalls).toEqual([mara.id])
    // A colleague still opens it after enrichment.
    const full = await retrieve(human(ana), { query: `launch ${campaignWord}`, detail: 'full' })
    expect(full.results.find((r) => r.id === maraThought)?.normalizedText).toContain(campaignWord)
  })

  it('the start-up re-key seals a co-worker’s thought written with a personal key with the company key', async () => {
    const { encryptTenantValue } = await import('$lib/server/crypto/tenant-encryption')
    const { reconcileAllMemoryKeysOf } = await import('$lib/server/memory/shared-memory-keys')
    await db.withDbUser(mara.id, async () => {
      const personal = await encryptTenantValue({
        userId: mara.id,
        table: 'thought',
        column: 'metadata',
        plaintext: '{"legacy":true}',
        scope: 'person',
      })
      await db.getDb().execute(sql`update thought set metadata_encrypted = ${personal} where id = ${maraThought}`)
      expect(await reconcileAllMemoryKeysOf(mara.id)).toMatchObject({ thoughts: 1 })
    })
    const [row] = await operator`select metadata_encrypted from thought where id = ${maraThought}`
    expect(keyOf(row!.metadata_encrypted)).toBe('company')
  })
})
