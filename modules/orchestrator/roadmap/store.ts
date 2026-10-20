import { eq } from 'drizzle-orm'
import type { DbHandle } from '$lib/kernel/db-stores'
import type { AppDatabase } from '$lib/server/db/context'
import { extensionRoadmapItems } from '$lib/server/db/roadmap.schema'

export type RoadmapStatus = 'shipped' | 'in_progress' | 'planned'
export type RoadmapKind = 'feature' | 'fix' | 'chore'

export type RoadmapItem = {
  id: string
  title: string
  detail: string
  status: RoadmapStatus
  kind: RoadmapKind
  position: number
  /** ISO-8601 timestamp, stamped when the status becomes 'shipped'. */
  shippedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CreateRoadmapItemInput = {
  title: string
  detail?: string
  status?: RoadmapStatus
  kind?: RoadmapKind
  position?: number
}

export type UpdateRoadmapItemPatch = {
  title?: string
  detail?: string
  status?: RoadmapStatus
  kind?: RoadmapKind
  position?: number
}

export type RoadmapStore = {
  list(): Promise<RoadmapItem[]>
  create(input: CreateRoadmapItemInput): Promise<RoadmapItem>
  /** Throws loud when the id is unknown. */
  update(id: string, patch: UpdateRoadmapItemPatch): Promise<RoadmapItem>
}

/** Display order of the roadmap sections (also the canonical list order). */
export const ROADMAP_STATUS_ORDER: readonly RoadmapStatus[] = ['shipped', 'in_progress', 'planned']

function compareItems(a: RoadmapItem, b: RoadmapItem): number {
  const rankDiff = ROADMAP_STATUS_ORDER.indexOf(a.status) - ROADMAP_STATUS_ORDER.indexOf(b.status)
  if (rankDiff !== 0) return rankDiff
  if (a.position !== b.position) return a.position - b.position
  return a.id.localeCompare(b.id)
}

/** shipped_at follow-up for a status patch: entering 'shipped' stamps now(), leaving it clears. */
function shippedAtForPatch(status: RoadmapStatus): { shippedAt: Date } | { shippedAt: null } {
  return status === 'shipped' ? { shippedAt: new Date() } : { shippedAt: null }
}

function nowIso(): string {
  return new Date().toISOString()
}

/** In-memory RoadmapStore for tests and in-memory kernel wiring. */
export class InMemoryRoadmapStore implements RoadmapStore {
  private readonly items = new Map<string, RoadmapItem>()

  async list(): Promise<RoadmapItem[]> {
    return [...this.items.values()].sort(compareItems)
  }

  async create(input: CreateRoadmapItemInput): Promise<RoadmapItem> {
    const ts = nowIso()
    const status = input.status ?? 'planned'
    const item: RoadmapItem = {
      id: crypto.randomUUID(),
      title: input.title,
      detail: input.detail ?? '',
      status,
      kind: input.kind ?? 'feature',
      position: input.position ?? 0,
      shippedAt: status === 'shipped' ? ts : null,
      createdAt: ts,
      updatedAt: ts,
    }
    this.items.set(item.id, item)
    return item
  }

  async update(id: string, patch: UpdateRoadmapItemPatch): Promise<RoadmapItem> {
    const current = this.items.get(id)
    if (!current) throw new Error(`unknown roadmap item: ${id}`)

    const updated: RoadmapItem = {
      ...current,
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.detail === undefined ? {} : { detail: patch.detail }),
      ...(patch.status === undefined
        ? {}
        : {
            status: patch.status,
            // Entering 'shipped' stamps the moment; leaving it clears the stamp.
            shippedAt: patch.status === 'shipped' ? nowIso() : null,
          }),
      ...(patch.kind === undefined ? {} : { kind: patch.kind }),
      ...(patch.position === undefined ? {} : { position: patch.position }),
      updatedAt: nowIso(),
    }
    this.items.set(id, updated)
    return updated
  }
}

type ItemRow = typeof extensionRoadmapItems.$inferSelect

function toItem(row: ItemRow): RoadmapItem {
  return {
    id: row.id,
    title: row.title,
    detail: row.detail,
    status: row.status,
    kind: row.kind,
    position: row.position,
    shippedAt: row.shippedAt ? row.shippedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function resolveDb(db: DbHandle): Promise<AppDatabase> {
  return typeof db === 'function' ? await db() : db
}

/**
 * RoadmapStore persisting to the extension_roadmap_items table. Unknown ids
 * fail loud via an explicit lookup before the update.
 */
export class DbRoadmapStore implements RoadmapStore {
  constructor(private readonly db: DbHandle) {}

  async list(): Promise<RoadmapItem[]> {
    const rows = await (await resolveDb(this.db)).select().from(extensionRoadmapItems)
    return rows.map(toItem).sort(compareItems)
  }

  async create(input: CreateRoadmapItemInput): Promise<RoadmapItem> {
    const rows = await (
      await resolveDb(this.db)
    )
      .insert(extensionRoadmapItems)
      .values({
        title: input.title,
        detail: input.detail ?? '',
        status: input.status ?? 'planned',
        kind: input.kind ?? 'feature',
        position: input.position ?? 0,
        ...(input.status === 'shipped' ? { shippedAt: new Date() } : {}),
      })
      .returning()
    if (!rows[0]) throw new Error('roadmap item insert returned no row')
    return toItem(rows[0])
  }

  async update(id: string, patch: UpdateRoadmapItemPatch): Promise<RoadmapItem> {
    const database = await resolveDb(this.db)
    const current = await database
      .select()
      .from(extensionRoadmapItems)
      .where(eq(extensionRoadmapItems.id, id))
      .limit(1)
    if (!current[0]) throw new Error(`unknown roadmap item: ${id}`)

    const rows = await database
      .update(extensionRoadmapItems)
      .set({
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.detail === undefined ? {} : { detail: patch.detail }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.status === undefined ? {} : shippedAtForPatch(patch.status)),
        ...(patch.kind === undefined ? {} : { kind: patch.kind }),
        ...(patch.position === undefined ? {} : { position: patch.position }),
        updatedAt: new Date(),
      })
      .where(eq(extensionRoadmapItems.id, id))
      .returning()
    if (!rows[0]) throw new Error(`roadmap item update returned no row: ${id}`)
    return toItem(rows[0])
  }
}

/**
 * Production store handle: lazily resolves the request-scoped DB (when inside
 * a request/ALS context) or the pooled app handle, so importing/wiring never
 * opens a connection.
 */
export function defaultRoadmapStore(): RoadmapStore {
  const db: DbHandle = async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    const scoped = appDbAsyncLocal.getStore()
    if (scoped) return scoped
    return createScopedDrizzle(appSql)
  }
  return new DbRoadmapStore(db)
}
