import { and, desc, eq, inArray, lt, ne, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import {
  memoryDocument,
  thought,
  thoughtEntity,
  thoughtMemoryDocument,
  type MemoryVisibility,
} from '$lib/server/db/schema'
import type { MemoryAuthorship } from '$lib/server/memory/authorship'
import {
  authorshipInsertValues,
  USER_AUTHORSHIP,
  resolveAuthorSqlCondition,
} from '$lib/server/memory/authorship'
import { computeLexicalText } from '$lib/server/memory/lexical-text'
import { MemoryReadOnlyError } from '$lib/server/memory/memory-read-only'
import { buildLexicalTsQuery } from '$lib/server/retrieval/lexical'
import type { DriveService } from '../../../../modules/drive/service'

/**
 * Memory's documents are Drive files (wish f3fc516e, drizzle/0191): each one a
 * Markdown file in its owner's My drive, shared with the whole company (a
 * company `view` grant, the default) or private (its owner alone). The brain
 * keeps an index row per document (`memory_document`: owner, authorship, the
 * shared/private switch, the lexical text it searches) under the same RLS as
 * the old text_file table, so a private document stays its owner's alone in
 * the brain — no admin or owner override. The text itself is read from Drive.
 *
 * The function names and record shapes stay those of the text-file API, so
 * the memory.*text_file* tools, the brain and the routes keep working; `id`
 * is now the Drive file id (an old text_file id still resolves to its copy).
 */

export const MAX_TEXT_FILE_BODY_BYTES = 512 * 1024
export const TEXT_FILE_PREVIEW_LEN = 200

export type TextFileRecord = {
  id: string
  title: string
  body: string
  author: 'user' | 'agent'
  authorLabel: string | null
  authorKeyId: string | null
  ownerId: string
  visibility: MemoryVisibility
  editable: boolean
  createdAt: string
  updatedAt: string
}

/** Whose documents a list or search covers: the reader's, colleagues' shared ones, or both. */
export type TextFileScope = 'mine' | 'team' | 'all'

export type TextFileAttachmentPreview = {
  id: string
  title: string
  preview: string
  updatedAt: string
}

export type TextFileSearchHit = {
  id: string
  title: string
  preview: string
  lexicalScore: number
  updatedAt: string
  author: 'user' | 'agent'
  authorLabel: string | null
  authorKeyId: string | null
  ownerId: string
  visibility: MemoryVisibility
  editable: boolean
}

export type TextFileLinkedThought = {
  id: string
  normalizedText: string
}

/** The live Drive (tests swap it with `vi.mock`). */
async function drive(): Promise<DriveService> {
  const { driveService } = await import('../../../../modules/drive')
  return driveService()
}

const asUser = (userId: string) => ({ kind: 'user' as const, userId })

function assertBodyWithinLimit(body: string): string {
  const trimmed = body.trim()
  const bytes = new TextEncoder().encode(trimmed).byteLength
  if (bytes > MAX_TEXT_FILE_BODY_BYTES) {
    throw new Error(`body exceeds maximum size of ${MAX_TEXT_FILE_BODY_BYTES} bytes`)
  }
  return trimmed
}

function normalizeTitle(title: string | undefined): string {
  return (title ?? '').trim()
}

function assertTitleOrBody(title: string, body: string): void {
  if (!title && !body) {
    throw new Error('title or body is required')
  }
}

function toPreview(body: string): string {
  return body.slice(0, TEXT_FILE_PREVIEW_LEN)
}

/**
 * The Drive file name for a document title: Drive names cannot hold / or \
 * and are at most 255 characters (structural, the title itself is kept as is
 * in the index). An untitled document is “Untitled document.md”.
 */
export function driveNameForTitle(title: string): string {
  const base = title.replace(/[/\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 240)
  return `${base && base !== '.' && base !== '..' ? base : 'Untitled document'}.md`
}

/** The document's Drive grants: its owner manages; shared = every member may read it. */
async function applyVisibility(
  ownerId: string,
  fileId: string,
  visibility: MemoryVisibility,
): Promise<void> {
  const entries: Parameters<DriveService['setGrants']>[3] = [
    { subject: { kind: 'user', userId: ownerId }, level: 'manage' },
  ]
  if (visibility === 'company') entries.push({ subject: { kind: 'company' }, level: 'view' })
  await (await drive()).setGrants(asUser(ownerId), 'file', fileId, entries)
}

const INDEX_COLUMNS = {
  id: memoryDocument.driveFileId,
  userId: memoryDocument.userId,
  title: memoryDocument.title,
  author: memoryDocument.author,
  authorLabel: memoryDocument.authorLabel,
  authorKeyId: memoryDocument.authorKeyId,
  visibility: memoryDocument.visibility,
  createdAt: memoryDocument.createdAt,
  updatedAt: memoryDocument.updatedAt,
}

type IndexRow = {
  id: string
  userId: string
  title: string
  author: 'user' | 'agent'
  authorLabel: string | null
  authorKeyId: string | null
  visibility: MemoryVisibility
  createdAt: Date
  updatedAt: Date
}

/** The reader's documents, colleagues' shared ones, or both: the same rule as the RLS read policies. */
function scopeCondition(readerId: string, scope: TextFileScope): SQL {
  if (scope === 'mine') return eq(memoryDocument.userId, readerId)
  if (scope === 'team')
    return and(ne(memoryDocument.userId, readerId), eq(memoryDocument.visibility, 'company'))!
  return or(eq(memoryDocument.userId, readerId), eq(memoryDocument.visibility, 'company'))!
}

/** A document id as given: its Drive file id, or the text_file id it was copied from. */
function idCondition(id: string): SQL {
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  return uuidLike
    ? or(eq(memoryDocument.driveFileId, id), sql`${memoryDocument.textFileId} = ${id}::uuid`)!
    : eq(memoryDocument.driveFileId, id)
}

/**
 * The document's text as the reader may read it in Drive; null when Drive no
 * longer shows it to them (trashed, deleted or unshared there).
 */
async function readBody(readerId: string, fileId: string): Promise<string | null> {
  try {
    return (await (await drive()).readText(asUser(readerId), fileId)).content
  } catch (err) {
    if ((err as { code?: string }).code === 'not_found') return null
    throw err
  }
}

function toRecord(readerId: string, row: IndexRow, body: string): TextFileRecord {
  return {
    id: row.id,
    title: row.title,
    body,
    author: row.author,
    authorLabel: row.authorLabel,
    authorKeyId: row.authorKeyId,
    ownerId: row.userId,
    visibility: row.visibility,
    editable: row.userId === readerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function withBodies(readerId: string, rows: IndexRow[]): Promise<TextFileRecord[]> {
  const out = await Promise.all(
    rows.map(async (row) => {
      const body = await readBody(readerId, row.id)
      return body === null ? null : toRecord(readerId, row, body)
    }),
  )
  return out.filter((r): r is TextFileRecord => r !== null)
}

/** The reader's own index row for a document id (Drive id or old text_file id). */
async function ownRow(userId: string, fileId: string): Promise<IndexRow | null> {
  const [row] = await getDb()
    .select(INDEX_COLUMNS)
    .from(memoryDocument)
    .where(and(idCondition(fileId), eq(memoryDocument.userId, userId)))
    .limit(1)
  return row ?? null
}

/**
 * The document exists for this reader but is a colleague's (shared): writes
 * are refused loud. Returns normally when it is not visible at all (the
 * caller answers "not found").
 */
async function refuseColleagueNote(readerId: string, fileId: string): Promise<void> {
  const [row] = await getDb()
    .select({ userId: memoryDocument.userId })
    .from(memoryDocument)
    .where(and(idCondition(fileId), ne(memoryDocument.userId, readerId)))
    .limit(1)
  if (!row) return
  const { ownerNameOf } = await import('$lib/server/memory/memory-owners')
  throw new MemoryReadOnlyError('note', await ownerNameOf(row.userId))
}

/**
 * Writes a new document: a Markdown file in the owner's My drive, its Drive
 * sharing set from `visibility`, and its brain index row. `at` and
 * `textFileId` are the startup backfill's (the copied text file's own time).
 */
export async function createTextFile(
  userId: string,
  input: {
    title?: string
    body?: string
    authorship?: MemoryAuthorship
    /** Default 'company': every member reads it. */
    visibility?: MemoryVisibility
    textFileId?: string
    at?: { createdAt: Date; updatedAt: Date }
  },
): Promise<TextFileRecord> {
  const visibility = input.visibility ?? 'company'
  const title = normalizeTitle(input.title)
  const body = assertBodyWithinLimit(typeof input.body === 'string' ? input.body : '')
  assertTitleOrBody(title, body)
  const d = await drive()
  const file = await d.createDocument(asUser(userId), null, 'md', driveNameForTitle(title), body)
  await applyVisibility(userId, file.id, visibility)
  const [row] = await getDb()
    .insert(memoryDocument)
    .values({
      driveFileId: file.id,
      userId,
      textFileId: input.textFileId ?? null,
      title,
      lexicalText: computeLexicalText(`${title} ${body}`),
      visibility,
      ...authorshipInsertValues(input.authorship ?? USER_AUTHORSHIP),
      ...(input.at ?? {}),
    })
    .returning(INDEX_COLUMNS)
  return toRecord(userId, row, body)
}

async function saveDocument(
  userId: string,
  current: IndexRow,
  next: { title: string; body: string },
  previousTitle: string,
): Promise<TextFileRecord> {
  const d = await drive()
  await d.writeText(asUser(userId), current.id, next.body)
  if (next.title !== previousTitle)
    await d.rename(asUser(userId), 'file', current.id, driveNameForTitle(next.title))
  const [row] = await getDb()
    .update(memoryDocument)
    .set({
      title: next.title,
      lexicalText: computeLexicalText(`${next.title} ${next.body}`),
      updatedAt: new Date(),
    })
    .where(and(eq(memoryDocument.driveFileId, current.id), eq(memoryDocument.userId, userId)))
    .returning(INDEX_COLUMNS)
  return toRecord(userId, row, next.body)
}

export async function updateTextFile(
  userId: string,
  fileId: string,
  input: { title?: string; body?: string },
): Promise<TextFileRecord | null> {
  const existing = await ownRow(userId, fileId)
  if (!existing) {
    await refuseColleagueNote(userId, fileId)
    return null
  }
  const body = await readBody(userId, existing.id)
  if (body === null) return null
  const nextTitle = input.title !== undefined ? normalizeTitle(input.title) : existing.title
  const nextBody = input.body !== undefined ? assertBodyWithinLimit(input.body) : body
  assertTitleOrBody(nextTitle, nextBody)
  return saveDocument(userId, existing, { title: nextTitle, body: nextBody }, existing.title)
}

/**
 * Append text to an existing document (deterministic concat). Default
 * separator is a single newline when the current body is non-empty and does
 * not already end with a newline.
 */
export async function appendTextFile(
  userId: string,
  fileId: string,
  input: { text: string; separator?: string },
): Promise<TextFileRecord | null> {
  const appendText = typeof input.text === 'string' ? input.text.trim() : ''
  if (!appendText) {
    throw new Error('text is required')
  }
  const existing = await ownRow(userId, fileId)
  if (!existing) {
    await refuseColleagueNote(userId, fileId)
    return null
  }
  const body = await readBody(userId, existing.id)
  if (body === null) return null
  const separator =
    input.separator !== undefined
      ? input.separator
      : body.length === 0 || body.endsWith('\n')
        ? ''
        : '\n'
  const nextBody = assertBodyWithinLimit(`${body}${separator}${appendText}`)
  assertTitleOrBody(existing.title, nextBody)
  return saveDocument(userId, existing, { title: existing.title, body: nextBody }, existing.title)
}

/**
 * Deletes a document from Memory: its Drive file goes to the owner's Drive
 * trash (restorable there for a while) and the brain forgets it.
 */
export async function deleteTextFile(userId: string, fileId: string): Promise<boolean> {
  const existing = await ownRow(userId, fileId)
  if (!existing) {
    await refuseColleagueNote(userId, fileId)
    return false
  }
  try {
    await (await drive()).moveToTrash(asUser(userId), 'file', existing.id)
  } catch (err) {
    // Already trashed or deleted in Drive: the brain still forgets it.
    if ((err as { code?: string }).code !== 'not_found') throw err
  }
  const deleted = await getDb()
    .delete(memoryDocument)
    .where(and(eq(memoryDocument.driveFileId, existing.id), eq(memoryDocument.userId, userId)))
    .returning({ id: memoryDocument.driveFileId })
  return deleted.length > 0
}

/**
 * Make a document private (its owner only) or share it with every member.
 * Only its owner may; the Drive grants change in the same step.
 */
export async function setTextFileVisibility(
  userId: string,
  fileId: string,
  visibility: MemoryVisibility,
): Promise<{ textFileId: string; visibility: MemoryVisibility } | null> {
  const existing = await ownRow(userId, fileId)
  if (!existing) {
    await refuseColleagueNote(userId, fileId)
    return null
  }
  await applyVisibility(userId, existing.id, visibility)
  const [row] = await getDb()
    .update(memoryDocument)
    .set({ visibility })
    .where(and(eq(memoryDocument.driveFileId, existing.id), eq(memoryDocument.userId, userId)))
    .returning({ id: memoryDocument.driveFileId, visibility: memoryDocument.visibility })
  return { textFileId: row.id, visibility: row.visibility }
}

/** One document the reader may read: their own, or a colleague's shared one (read-only). */
export async function getTextFile(userId: string, fileId: string): Promise<TextFileRecord | null> {
  const [row] = await getDb()
    .select(INDEX_COLUMNS)
    .from(memoryDocument)
    .where(and(idCondition(fileId), scopeCondition(userId, 'all')))
    .limit(1)
  if (!row) return null
  const [record] = await withBodies(userId, [row])
  return record ?? null
}

export async function listTextFiles(
  userId: string,
  options?: {
    limit?: number
    cursor?: { updatedAt: Date; id: string }
    authorLayerKey?: string | null
    /** Default 'all': the reader's documents and colleagues' shared ones. */
    scope?: TextFileScope
  },
): Promise<TextFileRecord[]> {
  const limit = Math.max(1, Math.min(options?.limit ?? 20, 100))
  const cursor = options?.cursor
  const authorSql = options?.authorLayerKey
    ? resolveAuthorSqlCondition(
        {
          author: memoryDocument.author,
          authorKeyId: memoryDocument.authorKeyId,
          authorLabel: memoryDocument.authorLabel,
        },
        { authorLayerKey: options.authorLayerKey },
      )
    : undefined

  const rows = await getDb()
    .select(INDEX_COLUMNS)
    .from(memoryDocument)
    .where(
      and(
        scopeCondition(userId, options?.scope ?? 'all'),
        authorSql,
        cursor
          ? or(
              lt(memoryDocument.updatedAt, cursor.updatedAt),
              and(
                eq(memoryDocument.updatedAt, cursor.updatedAt),
                lt(memoryDocument.driveFileId, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(memoryDocument.updatedAt), desc(memoryDocument.driveFileId))
    .limit(limit)

  return withBodies(userId, rows)
}

export async function searchTextFiles(
  userId: string,
  input: {
    query: string
    topK?: number
    authorFilter?: 'user' | 'agent'
    authorLayerKey?: string | null
    /** Default 'all'. Access is filtered in SQL before ranking. */
    scope?: TextFileScope
  },
): Promise<TextFileSearchHit[]> {
  const limit = Math.max(1, Math.min(input.topK ?? 10, 50))
  const tsQueryString = buildLexicalTsQuery(input.query)
  if (tsQueryString.length === 0) return []

  const tsQueryExpr = sql`to_tsquery('simple', ${tsQueryString})`
  const rankExpr = sql<number>`ts_rank_cd(${memoryDocument.lexicalTsv}, ${tsQueryExpr})`
  const matchExpr = sql<boolean>`${memoryDocument.lexicalTsv} @@ ${tsQueryExpr}`
  const authorSql = resolveAuthorSqlCondition(
    {
      author: memoryDocument.author,
      authorKeyId: memoryDocument.authorKeyId,
      authorLabel: memoryDocument.authorLabel,
    },
    { author: input.authorFilter, authorLayerKey: input.authorLayerKey },
  )

  const rows = await getDb()
    .select({ ...INDEX_COLUMNS, lexicalScore: rankExpr })
    .from(memoryDocument)
    .where(and(scopeCondition(userId, input.scope ?? 'all'), matchExpr, authorSql))
    .orderBy(desc(rankExpr))
    .limit(limit)

  const hits = await Promise.all(
    rows.map(async (row) => {
      const body = await readBody(userId, row.id)
      if (body === null) return null
      const file = toRecord(userId, row, body)
      return {
        id: file.id,
        title: file.title,
        preview: toPreview(file.body),
        lexicalScore: row.lexicalScore ?? 0,
        updatedAt: file.updatedAt,
        author: file.author,
        authorLabel: file.authorLabel,
        authorKeyId: file.authorKeyId,
        ownerId: file.ownerId,
        visibility: file.visibility,
        editable: file.editable,
      } satisfies TextFileSearchHit
    }),
  )
  return hits.filter((h): h is TextFileSearchHit => h !== null)
}

async function assertOwnedThought(userId: string, thoughtId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: thought.id })
    .from(thought)
    .where(and(eq(thought.id, thoughtId), eq(thought.userId, userId)))
    .limit(1)
  return Boolean(row)
}

export async function linkTextFileToThought(
  userId: string,
  thoughtId: string,
  textFileId: string,
): Promise<{ linked: boolean; reason?: 'thought_not_found' | 'text_file_not_found' }> {
  const [thoughtOk, own] = await Promise.all([
    assertOwnedThought(userId, thoughtId),
    // Only the person's own documents: a colleague's shared one is read-only for them.
    ownRow(userId, textFileId),
  ])

  if (!thoughtOk) return { linked: false, reason: 'thought_not_found' }
  if (!own) return { linked: false, reason: 'text_file_not_found' }

  await getDb()
    .insert(thoughtMemoryDocument)
    .values({ userId, thoughtId, driveFileId: own.id })
    .onConflictDoNothing()

  return { linked: true }
}

export async function unlinkTextFileFromThought(
  userId: string,
  thoughtId: string,
  textFileId: string,
): Promise<boolean> {
  const own = await ownRow(userId, textFileId)
  if (!own) return false
  const deleted = await getDb()
    .delete(thoughtMemoryDocument)
    .where(
      and(
        eq(thoughtMemoryDocument.userId, userId),
        eq(thoughtMemoryDocument.thoughtId, thoughtId),
        eq(thoughtMemoryDocument.driveFileId, own.id),
      ),
    )
    .returning({ thoughtId: thoughtMemoryDocument.thoughtId })

  return deleted.length > 0
}

export async function listTextFilesForThought(
  userId: string,
  thoughtId: string,
): Promise<TextFileAttachmentPreview[]> {
  return (await listTextFilesForThoughtIds(userId, [thoughtId])).get(thoughtId) ?? []
}

export async function listTextFilesForThoughtIds(
  userId: string,
  thoughtIds: string[],
): Promise<Map<string, TextFileAttachmentPreview[]>> {
  const uniqueIds = [...new Set(thoughtIds.filter((id) => id.trim().length > 0))]
  const result = new Map<string, TextFileAttachmentPreview[]>()
  if (uniqueIds.length === 0) return result

  const rows = await getDb()
    .select({ thoughtId: thoughtMemoryDocument.thoughtId, ...INDEX_COLUMNS })
    .from(thoughtMemoryDocument)
    .innerJoin(memoryDocument, eq(thoughtMemoryDocument.driveFileId, memoryDocument.driveFileId))
    .where(
      and(
        eq(thoughtMemoryDocument.userId, userId),
        inArray(thoughtMemoryDocument.thoughtId, uniqueIds),
      ),
    )
    .orderBy(desc(memoryDocument.updatedAt), desc(memoryDocument.driveFileId))

  const previews = await Promise.all(
    rows.map(async (row) => {
      const body = await readBody(userId, row.id)
      if (body === null) return null
      return {
        thoughtId: row.thoughtId,
        file: {
          id: row.id,
          title: row.title,
          preview: toPreview(body),
          updatedAt: row.updatedAt.toISOString(),
        } satisfies TextFileAttachmentPreview,
      }
    }),
  )

  for (const entry of previews) {
    if (!entry) continue
    const list = result.get(entry.thoughtId) ?? []
    list.push(entry.file)
    result.set(entry.thoughtId, list)
  }

  return result
}

export async function listThoughtsForTextFile(
  userId: string,
  textFileId: string,
): Promise<TextFileLinkedThought[]> {
  const own = await ownRow(userId, textFileId)
  if (!own) return []

  const rows = await getDb()
    .select({
      id: thought.id,
      normalizedText: thought.normalizedText,
    })
    .from(thoughtMemoryDocument)
    .innerJoin(thought, eq(thoughtMemoryDocument.thoughtId, thought.id))
    .where(
      and(eq(thoughtMemoryDocument.userId, userId), eq(thoughtMemoryDocument.driveFileId, own.id)),
    )
    .orderBy(desc(thought.createdAt), desc(thought.id))

  return rows.map((row) => ({
    id: row.id,
    normalizedText: row.normalizedText,
  }))
}

/**
 * Re-reads a document's text after it changed in Drive (its editor, an
 * upload over it) so the brain searches what it says now. Runs as the
 * document's owner (their RLS session); a Drive file that is no Memory
 * document is left alone.
 */
export async function reindexMemoryDocument(fileId: string, ownerId: string): Promise<void> {
  const { withDbUser } = await import('$lib/server/db')
  await withDbUser(ownerId, async (scoped) => {
    const [row] = await scoped
      .select({ title: memoryDocument.title })
      .from(memoryDocument)
      .where(and(eq(memoryDocument.driveFileId, fileId), eq(memoryDocument.userId, ownerId)))
      .limit(1)
    if (!row) return
    const body = await readBody(ownerId, fileId)
    if (body === null) return
    await scoped
      .update(memoryDocument)
      .set({ lexicalText: computeLexicalText(`${row.title} ${body}`), updatedAt: new Date() })
      .where(and(eq(memoryDocument.driveFileId, fileId), eq(memoryDocument.userId, ownerId)))
  })
}

/**
 * A Memory project's documents: the Drive files linked to the thoughts of
 * that project (the reader's own links; newest first).
 */
export async function listProjectDocuments(
  userId: string,
  projectEntityId: string,
): Promise<TextFileAttachmentPreview[]> {
  const rows = await getDb()
    .select({ thoughtId: thoughtEntity.thoughtId })
    .from(thoughtEntity)
    .where(and(eq(thoughtEntity.entityId, projectEntityId), eq(thoughtEntity.userId, userId)))
  const byThought = await listTextFilesForThoughtIds(
    userId,
    rows.map((r) => r.thoughtId),
  )
  const seen = new Map<string, TextFileAttachmentPreview>()
  for (const files of byThought.values()) for (const f of files) seen.set(f.id, f)
  return [...seen.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
