import { and, eq, ne, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { rowsFromDbExecute } from '$lib/server/db/execute-rows'
import { ontologyEntityKind, thought, thoughtEntity } from '$lib/server/db/schema'
import { computeLexicalText } from '$lib/server/memory/lexical-text'
import { roadmapItemFromTask, taskStateForStatus, type RoadmapTaskRow } from './task-mapping'

/** Tenant encryption opens the DB pool on import: load it on first use (wiring stays connection-free). */
const tenantCrypto = () => import('$lib/server/crypto/tenant-encryption')

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

/** Where the roadmap lives: the company owner's Memory, scoped by RLS. */
export type RoadmapMemoryAccess = {
  /** The user whose Memory holds the Roadmap project. Throws loud when there is none. */
  ownerId(): Promise<string>
  /** Run `fn` with the database scoped (RLS) to that user. */
  withUserDb<T>(userId: string, fn: (db: AppDatabase) => Promise<T>): Promise<T>
}

export class RoadmapOwnerMissingError extends Error {
  constructor() {
    super("The roadmap lives in the company owner's Memory, and this company has no owner yet.")
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TASK_COLUMNS = {
  id: thought.id,
  normalizedText: thought.normalizedText,
  normalizedTextEncrypted: thought.normalizedTextEncrypted,
  metadata: thought.metadata,
  metadataEncrypted: thought.metadataEncrypted,
  lifecycleStatus: thought.lifecycleStatus,
  lifecycleCompletedAt: thought.lifecycleCompletedAt,
  taskKind: thought.taskKind,
  taskStartedAt: thought.taskStartedAt,
  taskPosition: thought.taskPosition,
  createdAt: thought.createdAt,
  updatedAt: thought.updatedAt,
}

type TaskSelectRow = Omit<RoadmapTaskRow, 'title' | 'detail'> & {
  normalizedText: string
  normalizedTextEncrypted: string | null
  metadata: Record<string, unknown>
  metadataEncrypted: string | null
}

/**
 * The Roadmap system project's id in this user's Memory, created (and, for
 * the company owner, the legacy extension_roadmap_items rows adopted) by the
 * idempotent roadmap_ensure_project() from drizzle/0120.
 */
export async function ensureRoadmapProject(db: AppDatabase, userId: string): Promise<string> {
  const rows = rowsFromDbExecute<{ id: string | null }>(
    await db.execute(sql`select roadmap_ensure_project(${userId}) as id`),
  )
  const id = rows[0]?.id
  if (!id) throw new Error(`roadmap_ensure_project returned no project for ${userId}`)
  return id
}

/**
 * RoadmapStore over Memory (P-4): items are the tasks of the system project
 * "Roadmap" in the company owner's Memory — thought rows (category 'task')
 * linked to the project, with the roadmap vocabulary mapped onto the task
 * state (task-mapping.ts). Title and detail are written like every Memory
 * thought: plaintext columns plus tenant-encrypted copies, which win on read.
 * Roadmap tasks skip the capture enrich pipeline (no LLM reclassification).
 */
export class MemoryRoadmapStore implements RoadmapStore {
  constructor(private readonly access: RoadmapMemoryAccess) {}

  private async run<T>(
    fn: (db: AppDatabase, userId: string, projectId: string) => Promise<T>,
  ): Promise<T> {
    const userId = await this.access.ownerId()
    return this.access.withUserDb(userId, async (db) => {
      const projectId = await ensureRoadmapProject(db, userId)
      return fn(db, userId, projectId)
    })
  }

  /** The Roadmap project's entity id (ensured). */
  async projectId(): Promise<string> {
    return this.run(async (_db, _userId, projectId) => projectId)
  }

  async list(): Promise<RoadmapItem[]> {
    return this.run(async (db, userId, projectId) => {
      const rows: TaskSelectRow[] = await db
        .select(TASK_COLUMNS)
        .from(thought)
        .innerJoin(thoughtEntity, eq(thoughtEntity.thoughtId, thought.id))
        .where(
          and(
            eq(thought.userId, userId),
            eq(thought.category, 'task'),
            ne(thought.lifecycleStatus, 'archived'),
            eq(thoughtEntity.entityId, projectId),
          ),
        )
      const items: RoadmapItem[] = []
      for (const row of rows) {
        const item = roadmapItemFromTask(await readTask(userId, row))
        if (item) items.push(item)
      }
      return items.sort(compareItems)
    })
  }

  async create(input: CreateRoadmapItemInput): Promise<RoadmapItem> {
    return this.run(async (db, userId, projectId) => {
      const state = taskStateForStatus(input.status ?? 'planned', new Date())
      const encrypted = await encryptTask(userId, input.title, { detail: input.detail ?? '' })
      const [kind] = await db
        .select({ id: ontologyEntityKind.id })
        .from(ontologyEntityKind)
        .where(and(eq(ontologyEntityKind.userId, userId), eq(ontologyEntityKind.key, 'task')))
        .limit(1)
      if (!kind) throw new Error(`no 'task' thought category in the Memory of ${userId}`)

      const id = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(thought)
          .values({
            userId,
            rawText: input.title,
            normalizedText: input.title,
            lexicalText: computeLexicalText(input.title),
            category: 'task',
            ontologyEntityKindId: kind.id,
            metadata: { encrypted: true },
            captureSource: 'api',
            author: 'user',
            ...encrypted,
            ...state,
            taskKind: input.kind ?? 'feature',
            taskPosition: input.position ?? 0,
          })
          .returning({ id: thought.id })
        if (!row) throw new Error('roadmap task insert returned no row')
        await tx
          .insert(thoughtEntity)
          .values({ thoughtId: row.id, entityId: projectId, userId, salience: 1, source: 'manual' })
        return row.id
      })
      return getItem(db, userId, projectId, id)
    })
  }

  async update(id: string, patch: UpdateRoadmapItemPatch): Promise<RoadmapItem> {
    return this.run(async (db, userId, projectId) => {
      const current = UUID_RE.test(id) ? await findTask(db, userId, projectId, id) : null
      if (!current) throw new Error(`unknown roadmap item: ${id}`)
      const task = await readTask(userId, current)
      const title = patch.title ?? task.title
      const detail = patch.detail ?? task.detail
      const textChanged = patch.title !== undefined || patch.detail !== undefined
      const now = new Date()

      await db
        .update(thought)
        .set({
          ...(textChanged
            ? {
                rawText: title,
                normalizedText: title,
                lexicalText: computeLexicalText(title),
                metadata: { encrypted: true },
                ...(await encryptTask(userId, title, { ...task.metadata, detail })),
              }
            : {}),
          ...(patch.status === undefined
            ? {}
            : taskStateForStatus(patch.status, now, { taskStartedAt: current.taskStartedAt })),
          ...(patch.kind === undefined ? {} : { taskKind: patch.kind }),
          ...(patch.position === undefined ? {} : { taskPosition: patch.position }),
          updatedAt: now,
        })
        .where(and(eq(thought.userId, userId), eq(thought.id, id)))
      return getItem(db, userId, projectId, id)
    })
  }
}

async function findTask(
  db: AppDatabase,
  userId: string,
  projectId: string,
  id: string,
): Promise<TaskSelectRow | null> {
  const [row] = await db
    .select(TASK_COLUMNS)
    .from(thought)
    .innerJoin(thoughtEntity, eq(thoughtEntity.thoughtId, thought.id))
    .where(
      and(
        eq(thought.userId, userId),
        eq(thought.id, id),
        eq(thought.category, 'task'),
        ne(thought.lifecycleStatus, 'archived'),
        eq(thoughtEntity.entityId, projectId),
      ),
    )
    .limit(1)
  return row ?? null
}

async function getItem(
  db: AppDatabase,
  userId: string,
  projectId: string,
  id: string,
): Promise<RoadmapItem> {
  const row = await findTask(db, userId, projectId, id)
  const item = row ? roadmapItemFromTask(await readTask(userId, row)) : null
  if (!item) throw new Error(`roadmap item vanished after write: ${id}`)
  return item
}

async function encryptTask(userId: string, title: string, metadata: Record<string, unknown>) {
  const { encryptTenantValue } = await tenantCrypto()
  const [rawTextEncrypted, normalizedTextEncrypted, metadataEncrypted] = await Promise.all([
    encryptTenantValue({ userId, table: 'thought', column: 'raw_text', plaintext: title }),
    encryptTenantValue({ userId, table: 'thought', column: 'normalized_text', plaintext: title }),
    encryptTenantValue({
      userId,
      table: 'thought',
      column: 'metadata',
      plaintext: JSON.stringify(metadata),
    }),
  ])
  return { rawTextEncrypted, normalizedTextEncrypted, metadataEncrypted }
}

/** The task as the roadmap reads it, plus its full metadata (kept on rewrite). */
async function readTask(
  userId: string,
  row: TaskSelectRow,
): Promise<RoadmapTaskRow & { metadata: Record<string, unknown> }> {
  const { decryptTenantValue } = await tenantCrypto()
  const title = row.normalizedTextEncrypted
    ? await decryptTenantValue({
        userId,
        table: 'thought',
        column: 'normalized_text',
        ciphertext: row.normalizedTextEncrypted,
      })
    : row.normalizedText
  const metadata = row.metadataEncrypted
    ? (JSON.parse(
        await decryptTenantValue({
          userId,
          table: 'thought',
          column: 'metadata',
          ciphertext: row.metadataEncrypted,
        }),
      ) as Record<string, unknown>)
    : row.metadata
  return {
    id: row.id,
    title,
    detail: typeof metadata.detail === 'string' ? metadata.detail : '',
    metadata,
    lifecycleStatus: row.lifecycleStatus,
    lifecycleCompletedAt: row.lifecycleCompletedAt,
    taskKind: row.taskKind,
    taskStartedAt: row.taskStartedAt,
    taskPosition: row.taskPosition,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** The company owner's user id (exactly one: unique index on user.role). */
async function companyOwnerId(): Promise<string> {
  const { authDb } = await import('$lib/server/db/auth-db')
  const { user } = await import('$lib/server/db/auth.schema')
  const [row] = await authDb
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, 'owner'))
    .limit(1)
  if (!row) throw new RoadmapOwnerMissingError()
  return row.id
}

/**
 * Production store: the Roadmap project in the company owner's Memory, every
 * operation on a connection scoped (RLS) to the owner — members read the
 * company roadmap through this store, never through their own Memory.
 * Importing/wiring never opens a connection.
 */
export function defaultRoadmapStore(): MemoryRoadmapStore {
  return new MemoryRoadmapStore({
    ownerId: companyOwnerId,
    withUserDb: async (userId, fn) => {
      const { withDbUser } = await import('$lib/server/db')
      return withDbUser(userId, fn)
    },
  })
}
