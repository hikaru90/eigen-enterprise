import type { BrandCorpusItem } from '../style-format/corpus'
import type { BrandSeeds } from '../style-format/seeds'
import type { ProposedCandidate } from './propose'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DbHandle } from '$lib/kernel/db-stores'
import {
  brandCorpusStaging,
  brandExtractionGuides,
  brandExtractionRounds,
  brandExtractionSessions,
  type BrandExtractionVerdict,
} from '$lib/server/db/brand.schema'
import { corpusItemSchema } from '../style-format/corpus'
import { GUIDE_MIMES, type BrandGuideMeta } from './guide'

/**
 * BrandExtractionStore (phase-2d M2): durable state for the design-system
 * extraction judge loop. Round 0 stores the capture facts (digest + screenshot);
 * rounds 1+ store one candidate triplet each plus the owner's verdict.
 * Staging rows hold accepted corpus items — staging is NOT publishing (2c D5).
 *
 * A session reads a captured site (source 'url') or an uploaded brand guide
 * (source 'guide'). A guide session has no URL and no screenshot: its rounds
 * carry an empty screenshot and the guide itself is kept next to the session.
 */

export type BrandExtractionSessionStatus = 'active' | 'accepted' | 'abandoned'
export type BrandExtractionSource = 'url' | 'guide'

export type BrandExtractionSession = {
  id: string
  source: BrandExtractionSource
  /** The captured site; null for a guide session. */
  url: string | null
  /** The site's title, or the guide's file name. */
  title: string | null
  status: BrandExtractionSessionStatus
  createdAt: string
}

/** An uploaded brand guide with its bytes (base64). */
export type BrandGuide = BrandGuideMeta & { base64: string }

export type BrandExtractionRound = {
  id: string
  sessionId: string
  round: number
  digest: string
  screenshotB64: string
  candidates: ProposedCandidate[]
  verdict: BrandExtractionVerdict | null
  createdAt: string
}

export type BrandCorpusStagedRow = {
  id: string
  sessionId: string | null
  name: string
  corpusItem: BrandCorpusItem
  status: 'staged' | 'exported'
  createdAt: string
}

export const createSessionInputSchema = z.object({
  url: z.string().min(1),
  title: z.string().min(1).nullable(),
})

export const createGuideSessionInputSchema = z.object({
  guide: z.object({
    filename: z.string().min(1),
    mime: z.enum(GUIDE_MIMES),
    sizeBytes: z.number().int().positive(),
    base64: z.string().min(1),
  }),
})

export const createRoundInputSchema = z.object({
  sessionId: z.string().uuid(),
  round: z.number().int().min(0),
  digest: z.string().min(1),
  /** The capture screenshot: required for a URL session, empty for a guide session (assertRoundShape). */
  screenshotB64: z.string(),
  candidates: z.array(z.custom<ProposedCandidate>(() => true)),
})

export const judgeRoundInputSchema = z.object({
  sessionId: z.string().uuid(),
  round: z.number().int().min(0),
  chosen: z.number().int().min(0).nullable(),
  note: z.string().min(1).optional(),
})

export type CreateSessionInput = z.infer<typeof createSessionInputSchema>
export type CreateGuideSessionInput = z.infer<typeof createGuideSessionInputSchema>
export type CreateRoundInput = z.infer<typeof createRoundInputSchema>
export type JudgeRoundInput = z.infer<typeof judgeRoundInputSchema>

export type BrandExtractionStore = {
  /** A URL session (the captured site). */
  createSession(input: CreateSessionInput): Promise<BrandExtractionSession>
  /** A guide session: the session and its uploaded guide, stored together. */
  createGuideSession(input: CreateGuideSessionInput): Promise<BrandExtractionSession>
  /** The guide with its bytes; null for a URL session. */
  getGuide(sessionId: string): Promise<BrandGuide | null>
  /** The guide without its bytes (name, type, size); null for a URL session. */
  getGuideMeta(sessionId: string): Promise<BrandGuideMeta | null>
  getSession(sessionId: string): Promise<BrandExtractionSession | null>
  /** Full session read for the judge UI; fails loud on unknown ids. */
  requireSession(sessionId: string): Promise<BrandExtractionSession>
  createRound(input: CreateRoundInput): Promise<BrandExtractionRound>
  listRounds(sessionId: string): Promise<BrandExtractionRound[]>
  getRound(sessionId: string, round: number): Promise<BrandExtractionRound | null>
  /** Stores the owner verdict; chosen=null rejects the round. Fails loud on unknown rounds. */
  judgeRound(input: JudgeRoundInput): Promise<BrandExtractionRound>
  /**
   * Requires an active session and a judged round with chosen != null, stages
   * the chosen candidate as a corpus item, marks the session accepted.
   */
  accept(sessionId: string, name: string): Promise<BrandCorpusStagedRow>
  listStaged(): Promise<BrandCorpusStagedRow[]>
  markExported(id: string): Promise<BrandCorpusStagedRow>
}

function nowIso(): string {
  return new Date().toISOString()
}

function chosenCandidate(
  round: BrandExtractionRound,
): ProposedCandidate & {
  seeds: BrandSeeds
  cssVars: Record<string, string>
  darkCssVars: Record<string, string>
} {
  if (round.verdict === null) {
    throw new Error(
      `round ${round.round} of session ${round.sessionId} has no verdict yet — judge it first`,
    )
  }
  if (round.verdict.chosen === null) {
    throw new Error(
      `round ${round.round} of session ${round.sessionId} was rejected (chosen=null) — nothing to accept`,
    )
  }
  const candidate = round.candidates[round.verdict.chosen]
  if (!candidate || !('seeds' in candidate)) {
    throw new Error(
      `round ${round.round} candidate #${round.verdict.chosen} is not an acceptable proposal (missing or invalid)`,
    )
  }
  return candidate as ProposedCandidate & {
    seeds: BrandSeeds
    cssVars: Record<string, string>
    darkCssVars: Record<string, string>
  }
}

function buildCorpusItem(
  session: BrandExtractionSession,
  candidate: {
    seeds: BrandSeeds
    cssVars: Record<string, string>
    darkCssVars: Record<string, string>
  },
  name: string,
): BrandCorpusItem {
  return corpusItemSchema.parse({
    id: crypto.randomUUID(),
    name,
    seeds: candidate.seeds,
    cssVars: candidate.cssVars,
    darkCssVars: candidate.darkCssVars,
    provenance:
      session.source === 'url'
        ? { source: 'extraction', url: session.url, capturedAt: session.createdAt }
        : {
            source: 'extraction',
            capturedAt: session.createdAt,
            note: `brand guide “${session.title}”`,
          },
    createdAt: nowIso(),
  })
}

/** A URL session's rounds carry the capture screenshot; a guide session's carry none. */
function assertRoundShape(session: BrandExtractionSession, input: CreateRoundInput): void {
  if (session.source === 'url' && input.screenshotB64.length === 0) {
    throw new Error(
      `round ${input.round} of URL session ${session.id} needs the capture screenshot`,
    )
  }
  if (session.source === 'guide' && input.screenshotB64.length > 0) {
    throw new Error(
      `round ${input.round} of guide session ${session.id} has no screenshot — the guide is stored with the session`,
    )
  }
}

function guideMeta(guide: BrandGuide): BrandGuideMeta {
  return { filename: guide.filename, mime: guide.mime, sizeBytes: guide.sizeBytes }
}

function assertJudgeable(round: BrandExtractionRound, chosen: number | null): void {
  if (chosen === null) return
  if (chosen < 0 || chosen >= round.candidates.length) {
    throw new Error(
      `verdict chosen=${chosen} is out of range for round ${round.round} with ${round.candidates.length} candidates`,
    )
  }
}

/** In-memory BrandExtractionStore for tests and in-memory kernel wiring. */
export class InMemoryBrandExtractionStore implements BrandExtractionStore {
  private readonly sessions = new Map<string, BrandExtractionSession>()
  private readonly rounds = new Map<string, BrandExtractionRound>()
  private readonly staged: BrandCorpusStagedRow[] = []
  private readonly guides = new Map<string, BrandGuide>()

  async createSession(input: CreateSessionInput): Promise<BrandExtractionSession> {
    const parsed = createSessionInputSchema.parse(input)
    const session: BrandExtractionSession = {
      id: crypto.randomUUID(),
      source: 'url',
      url: parsed.url,
      title: parsed.title,
      status: 'active',
      createdAt: nowIso(),
    }
    this.sessions.set(session.id, session)
    return session
  }

  async createGuideSession(input: CreateGuideSessionInput): Promise<BrandExtractionSession> {
    const { guide } = createGuideSessionInputSchema.parse(input)
    const session: BrandExtractionSession = {
      id: crypto.randomUUID(),
      source: 'guide',
      url: null,
      title: guide.filename,
      status: 'active',
      createdAt: nowIso(),
    }
    this.sessions.set(session.id, session)
    this.guides.set(session.id, guide)
    return session
  }

  async getGuide(sessionId: string): Promise<BrandGuide | null> {
    return this.guides.get(sessionId) ?? null
  }

  async getGuideMeta(sessionId: string): Promise<BrandGuideMeta | null> {
    const guide = this.guides.get(sessionId)
    return guide ? guideMeta(guide) : null
  }

  async getSession(sessionId: string): Promise<BrandExtractionSession | null> {
    return this.sessions.get(sessionId) ?? null
  }

  async requireSession(sessionId: string): Promise<BrandExtractionSession> {
    const session = await this.getSession(sessionId)
    if (!session) throw new Error(`unknown brand extraction session: ${sessionId}`)
    return session
  }

  async createRound(input: CreateRoundInput): Promise<BrandExtractionRound> {
    const parsed = createRoundInputSchema.parse(input)
    assertRoundShape(await this.requireSession(parsed.sessionId), parsed)
    const existing = await this.listRounds(parsed.sessionId)
    if (existing.some((r) => r.round === parsed.round)) {
      throw new Error(`round ${parsed.round} already exists for session ${parsed.sessionId}`)
    }
    const round: BrandExtractionRound = {
      id: crypto.randomUUID(),
      sessionId: parsed.sessionId,
      round: parsed.round,
      digest: parsed.digest,
      screenshotB64: parsed.screenshotB64,
      candidates: parsed.candidates,
      verdict: null,
      createdAt: nowIso(),
    }
    this.rounds.set(round.id, round)
    return round
  }

  async listRounds(sessionId: string): Promise<BrandExtractionRound[]> {
    return [...this.rounds.values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.round - b.round)
  }

  async getRound(sessionId: string, round: number): Promise<BrandExtractionRound | null> {
    return (await this.listRounds(sessionId)).find((r) => r.round === round) ?? null
  }

  async judgeRound(input: JudgeRoundInput): Promise<BrandExtractionRound> {
    const parsed = judgeRoundInputSchema.parse(input)
    const round = await this.getRound(parsed.sessionId, parsed.round)
    if (!round) {
      throw new Error(`unknown round ${parsed.round} for session ${parsed.sessionId}`)
    }
    assertJudgeable(round, parsed.chosen)
    const judged: BrandExtractionRound = {
      ...round,
      verdict: {
        chosen: parsed.chosen,
        ...(parsed.note === undefined ? {} : { note: parsed.note }),
      },
    }
    this.rounds.set(round.id, judged)
    return judged
  }

  async accept(sessionId: string, name: string): Promise<BrandCorpusStagedRow> {
    const session = await this.requireSession(sessionId)
    if (session.status !== 'active') {
      throw new Error(
        `session ${sessionId} is ${session.status}; only active sessions can accept a candidate`,
      )
    }
    const rounds = await this.listRounds(sessionId)
    const judged = rounds.filter((r) => r.verdict !== null && r.verdict.chosen !== null)
    if (judged.length === 0) {
      throw new Error(
        `session ${sessionId} has no judged round with a chosen candidate — judge a round before accepting`,
      )
    }
    const latest = judged[judged.length - 1]
    const candidate = chosenCandidate(latest)
    const row: BrandCorpusStagedRow = {
      id: crypto.randomUUID(),
      sessionId,
      name,
      corpusItem: buildCorpusItem(session, candidate, name),
      status: 'staged',
      createdAt: nowIso(),
    }
    this.staged.push(row)
    this.sessions.set(sessionId, { ...session, status: 'accepted' })
    return row
  }

  async listStaged(): Promise<BrandCorpusStagedRow[]> {
    return this.staged.filter((row) => row.status === 'staged')
  }

  async markExported(id: string): Promise<BrandCorpusStagedRow> {
    const row = this.staged.find((r) => r.id === id)
    if (!row || row.status !== 'staged') {
      throw new Error(`unknown staged corpus item (or already exported): ${id}`)
    }
    row.status = 'exported'
    return row
  }
}

// ---------------------------------------------------------------------------
// DB-backed store
// ---------------------------------------------------------------------------

type SessionRow = typeof brandExtractionSessions.$inferSelect
type RoundRow = typeof brandExtractionRounds.$inferSelect
type StagedRow = typeof brandCorpusStaging.$inferSelect

function toSession(row: SessionRow): BrandExtractionSession {
  return {
    id: row.id,
    source: row.source,
    url: row.url,
    title: row.title,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }
}

function toRound(row: RoundRow): BrandExtractionRound {
  return {
    id: row.id,
    sessionId: row.sessionId,
    round: row.round,
    digest: row.digest,
    screenshotB64: row.screenshotB64,
    candidates: row.candidates as ProposedCandidate[],
    verdict: row.verdict ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

function toStaged(row: StagedRow): BrandCorpusStagedRow {
  return {
    id: row.id,
    sessionId: row.sessionId,
    name: row.name,
    corpusItem: corpusItemSchema.parse(row.corpusItem),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }
}

async function resolveDb(db: DbHandle) {
  return typeof db === 'function' ? await db() : db
}

async function requireDbSession(
  database: Awaited<ReturnType<typeof resolveDb>>,
  sessionId: string,
): Promise<BrandExtractionSession> {
  const rows = await database
    .select()
    .from(brandExtractionSessions)
    .where(eq(brandExtractionSessions.id, sessionId))
    .limit(1)
  if (!rows[0]) throw new Error(`unknown brand extraction session: ${sessionId}`)
  return toSession(rows[0])
}

export class DbBrandExtractionStore implements BrandExtractionStore {
  constructor(private readonly db: DbHandle) {}

  async createSession(input: CreateSessionInput): Promise<BrandExtractionSession> {
    const parsed = createSessionInputSchema.parse(input)
    const database = await resolveDb(this.db)
    const rows = await database
      .insert(brandExtractionSessions)
      .values({ url: parsed.url, title: parsed.title })
      .returning()
    if (!rows[0]) throw new Error('brand extraction session insert returned no row')
    return toSession(rows[0])
  }

  async createGuideSession(input: CreateGuideSessionInput): Promise<BrandExtractionSession> {
    const { guide } = createGuideSessionInputSchema.parse(input)
    const database = await resolveDb(this.db)
    return database.transaction(async (tx) => {
      const rows = await tx
        .insert(brandExtractionSessions)
        .values({ source: 'guide', url: null, title: guide.filename })
        .returning()
      if (!rows[0]) throw new Error('brand guide session insert returned no row')
      await tx.insert(brandExtractionGuides).values({
        sessionId: rows[0].id,
        filename: guide.filename,
        mime: guide.mime,
        sizeBytes: guide.sizeBytes,
        dataB64: guide.base64,
      })
      return toSession(rows[0])
    })
  }

  async getGuide(sessionId: string): Promise<BrandGuide | null> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandExtractionGuides)
      .where(eq(brandExtractionGuides.sessionId, sessionId))
      .limit(1)
    const row = rows[0]
    return row
      ? { filename: row.filename, mime: row.mime, sizeBytes: row.sizeBytes, base64: row.dataB64 }
      : null
  }

  async getGuideMeta(sessionId: string): Promise<BrandGuideMeta | null> {
    const database = await resolveDb(this.db)
    // Name, type and size only: the bytes stay in the row.
    const rows = await database
      .select({
        filename: brandExtractionGuides.filename,
        mime: brandExtractionGuides.mime,
        sizeBytes: brandExtractionGuides.sizeBytes,
      })
      .from(brandExtractionGuides)
      .where(eq(brandExtractionGuides.sessionId, sessionId))
      .limit(1)
    return rows[0] ?? null
  }

  async getSession(sessionId: string): Promise<BrandExtractionSession | null> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandExtractionSessions)
      .where(eq(brandExtractionSessions.id, sessionId))
      .limit(1)
    return rows[0] ? toSession(rows[0]) : null
  }

  async requireSession(sessionId: string): Promise<BrandExtractionSession> {
    return requireDbSession(await resolveDb(this.db), sessionId)
  }

  async createRound(input: CreateRoundInput): Promise<BrandExtractionRound> {
    const parsed = createRoundInputSchema.parse(input)
    const database = await resolveDb(this.db)
    assertRoundShape(await requireDbSession(database, parsed.sessionId), parsed)
    const rows = await database
      .insert(brandExtractionRounds)
      .values({
        sessionId: parsed.sessionId,
        round: parsed.round,
        digest: parsed.digest,
        screenshotB64: parsed.screenshotB64,
        candidates: parsed.candidates,
      })
      .returning()
    if (!rows[0]) throw new Error('brand extraction round insert returned no row')
    return toRound(rows[0])
  }

  async listRounds(sessionId: string): Promise<BrandExtractionRound[]> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandExtractionRounds)
      .where(eq(brandExtractionRounds.sessionId, sessionId))
      .orderBy(brandExtractionRounds.round)
    return rows.map(toRound)
  }

  async getRound(sessionId: string, round: number): Promise<BrandExtractionRound | null> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandExtractionRounds)
      .where(
        and(eq(brandExtractionRounds.sessionId, sessionId), eq(brandExtractionRounds.round, round)),
      )
      .limit(1)
    return rows[0] ? toRound(rows[0]) : null
  }

  async judgeRound(input: JudgeRoundInput): Promise<BrandExtractionRound> {
    const parsed = judgeRoundInputSchema.parse(input)
    const database = await resolveDb(this.db)
    const round = await this.getRound(parsed.sessionId, parsed.round)
    if (!round) {
      throw new Error(`unknown round ${parsed.round} for session ${parsed.sessionId}`)
    }
    assertJudgeable(round, parsed.chosen)
    const verdict: BrandExtractionVerdict = {
      chosen: parsed.chosen,
      ...(parsed.note === undefined ? {} : { note: parsed.note }),
    }
    const rows = await database
      .update(brandExtractionRounds)
      .set({ verdict })
      .where(
        and(
          eq(brandExtractionRounds.sessionId, parsed.sessionId),
          eq(brandExtractionRounds.round, parsed.round),
        ),
      )
      .returning()
    if (!rows[0]) throw new Error(`verdict update returned no row: round ${parsed.round}`)
    return toRound(rows[0])
  }

  async accept(sessionId: string, name: string): Promise<BrandCorpusStagedRow> {
    const database = await resolveDb(this.db)
    const session = await requireDbSession(database, sessionId)
    if (session.status !== 'active') {
      throw new Error(
        `session ${sessionId} is ${session.status}; only active sessions can accept a candidate`,
      )
    }
    const rounds = await this.listRounds(sessionId)
    const judged = rounds.filter((r) => r.verdict !== null && r.verdict.chosen !== null)
    if (judged.length === 0) {
      throw new Error(
        `session ${sessionId} has no judged round with a chosen candidate — judge a round before accepting`,
      )
    }
    const candidate = chosenCandidate(judged[judged.length - 1])
    const corpusItem = buildCorpusItem(session, candidate, name)
    const inserted = await database
      .insert(brandCorpusStaging)
      .values({ sessionId, name, corpusItem })
      .returning()
    if (!inserted[0]) throw new Error('brand corpus staging insert returned no row')
    const updated = await database
      .update(brandExtractionSessions)
      .set({ status: 'accepted' })
      .where(eq(brandExtractionSessions.id, sessionId))
      .returning()
    if (!updated[0]) throw new Error(`session accept update returned no row: ${sessionId}`)
    return toStaged(inserted[0])
  }

  async listStaged(): Promise<BrandCorpusStagedRow[]> {
    const database = await resolveDb(this.db)
    const rows = await database
      .select()
      .from(brandCorpusStaging)
      .where(eq(brandCorpusStaging.status, 'staged'))
      .orderBy(desc(brandCorpusStaging.createdAt))
    return rows.map(toStaged)
  }

  async markExported(id: string): Promise<BrandCorpusStagedRow> {
    const database = await resolveDb(this.db)
    const rows = await database
      .update(brandCorpusStaging)
      .set({ status: 'exported' })
      .where(and(eq(brandCorpusStaging.id, id), eq(brandCorpusStaging.status, 'staged')))
      .returning()
    if (!rows[0]) throw new Error(`unknown staged corpus item (or already exported): ${id}`)
    return toStaged(rows[0])
  }
}

/**
 * Production store handle: lazily resolves the request-scoped DB (when inside
 * a request/ALS context) or the pooled app handle (same idiom as defaultBrandStore).
 */
export function defaultBrandExtractionStore(): BrandExtractionStore {
  const db: DbHandle = async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    const scoped = appDbAsyncLocal.getStore()
    if (scoped) return scoped
    return createScopedDrizzle(appSql)
  }
  return new DbBrandExtractionStore(db)
}
