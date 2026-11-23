import { and, eq } from 'drizzle-orm'
import { captureThought, editStoredThought, listThoughts } from '$lib/server/capture/service'
import { encryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { parseOptionalIsoTimestamp } from '$lib/server/datetime/parse-iso'
import { getDb } from '$lib/server/db'
import { thought, type MemoryAuthor } from '$lib/server/db/schema'
import { thoughtSnippet } from '$lib/server/mcp/snippet'
import {
  resolveMcpCaptureAuthorship,
  type AuthenticatedApiKey,
} from '$lib/server/memory/authorship'
import { generateProjectPlan } from '$lib/server/memory/generate-project-plan'
import { archiveThoughtForUser } from '$lib/server/memory/lifecycle'
import { ownerNameOf, thoughtOwnersOf, withOwners, type ThoughtOwner } from '$lib/server/memory/memory-owners'
import { resolveProjectAccess, setProjectVisibility } from '$lib/server/memory/memory-visibility'
import {
  listProjectsForUser,
  createProject,
  updateProjectLabel,
  updateProjectStatus,
  dismissProject,
} from '$lib/server/memory/project-list'
import { orderTaskInProject } from '$lib/server/memory/project-task-sequence'
import {
  listMilestonesForProject,
  setProjectDeadline,
  setProjectMilestone,
} from '$lib/server/memory/project-timeline'
import { reconcileThoughtKeys } from '$lib/server/memory/shared-memory-keys'
import { listTeamProjects, loadProjectForReader } from '$lib/server/memory/team-projects'
import {
  compactTemporalFieldsForMcp,
  enhanceSnippetWithTemporalContext,
  loadTemporalContextByThoughtIds,
} from '$lib/server/memory/temporal-context'
import { sanitizeMcpToolResult } from '$lib/server/observability/strip-embeddings'
import { composeAnswer } from '$lib/server/qa/compose-answer'
import { CONTEXT_WEIGHTS } from '$lib/server/retrieval'
import { tryRecordRetrievalQualityEvent } from '$lib/server/retrieval/quality-telemetry'
import { THOUGHT_REACHES, type ThoughtReach } from '$lib/server/retrieval/reach'
import { normalizeRetrievalScore } from '$lib/server/retrieval/rrf-scoring'
import { searchThoughts } from '$lib/server/retrieval/service'
import {
  appendTextFile,
  createTextFile,
  deleteTextFile,
  getTextFile,
  linkTextFileToThought,
  listTextFiles,
  searchTextFiles,
  setTextFileVisibility,
  unlinkTextFileFromThought,
  updateTextFile,
} from '$lib/server/text-files/service'
import type { TextFileScope } from '$lib/server/text-files/service'
import { readThoughtIdFromToolArgs, validateNonEmptyEntityId, validateSearchParams } from '$lib/server/validation/mcp-args'

export type McpToolProgress = {
  tool: string
  phase: string
  label: string
}

export type McpToolContext = {
  userId: string
  /** Present when MCP authenticated via Bearer API key — default capture authorship. */
  authenticatedApiKey?: AuthenticatedApiKey
  onToolProgress?: (event: McpToolProgress) => void
  /**
   * The caller is an AI co-worker acting as itself (plan/phase-ai-coworkers.md §7):
   * everything it captures is its own and recorded as written by it (author
   * 'agent', its name), so reads do not narrow its own thoughts to author 'user'.
   */
  coworker?: { name: string }
}

function asObject(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

function parseDetailLevel(body: Record<string, unknown>): 'snippet' | 'full' {
  const detail = body.detail
  return detail === 'full' ? 'full' : 'snippet'
}

function parseRetrieveOrder(body: Record<string, unknown>): 'created_at' | 'relevance' {
  return body.order === 'created_at' ? 'created_at' : 'relevance'
}

/** Default user-authored memories; `author: all` or `include_agent: true` returns undefined (no filter). */
function parseAuthorScope(body: Record<string, unknown>): MemoryAuthor | undefined {
  const author = body.author
  if (author === 'user' || author === 'agent') return author
  if (author === 'all' || body.include_agent === true) return undefined
  return 'user'
}

/**
 * The author filter of a thought read. A co-worker's own thoughts are all
 * written by it (author 'agent'), so for a co-worker the default is no filter.
 */
function parseThoughtAuthorScope(context: McpToolContext, body: Record<string, unknown>): MemoryAuthor | undefined {
  if (context.coworker && body.author === undefined && body.include_agent === undefined) return undefined
  return parseAuthorScope(body)
}

/**
 * Whose thoughts a read reaches (retrieval/reach.ts): mine | team (the AI
 * co-workers' company-visible thoughts) | all (default). A person's thoughts are
 * never in reach of anyone else.
 */
function parseThoughtReach(body: Record<string, unknown>): ThoughtReach {
  const scope = body.scope
  if (scope === undefined) return 'all'
  if (typeof scope === 'string' && (THOUGHT_REACHES as readonly string[]).includes(scope)) return scope as ThoughtReach
  throw new Error(`scope must be one of ${THOUGHT_REACHES.join(', ')}`)
}

/** Every thought result names its owner (name, kind) and whether the reader may change it (only their own). */
async function markThoughtOwners<T extends { ownerId: string }>(
  readerId: string,
  rows: T[],
): Promise<Array<Omit<T, 'ownerId'> & { owner: ThoughtOwner; editable: boolean }>> {
  const owners = await thoughtOwnersOf(rows.map((row) => row.ownerId))
  return rows.map(({ ownerId, ...row }) => ({ ...row, owner: owners.get(ownerId)!, editable: ownerId === readerId }))
}

async function listRecentThoughtsForMcp(
  context: McpToolContext,
  input: {
    limit: number
    detail: 'snippet' | 'full'
    cursor?: { createdAt: Date; id: string }
    weights: { vector: number; graph: number }
    authorFilter?: MemoryAuthor
    reach: ThoughtReach
  },
) {
  const thoughts = await listThoughts(context.userId, {
    limit: input.limit,
    fields: input.detail === 'full' ? 'full' : 'snippet',
    cursor: input.cursor,
    ...(input.authorFilter ? { authorFilter: input.authorFilter } : {}),
    reach: input.reach,
  })

  if (input.detail === 'full') {
    return sanitizeMcpToolResult({
      count: thoughts.length,
      results: await markThoughtOwners(context.userId, thoughts),
    })
  }

  const now = new Date()
  const snippetRows = await buildMcpThoughtSnippetRows(
    context.userId,
    thoughts.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      category: row.category,
      createdAt: row.createdAt,
      normalizedText: row.normalizedText,
      author: row.author,
      authorLabel: row.authorLabel,
    })),
    input.weights,
    now,
  )

  return sanitizeMcpToolResult({
    count: snippetRows.length,
    results: snippetRows,
  })
}

type McpThoughtSnippetRow = {
  id: string
  ownerId: string
  category: string
  createdAt: Date
  normalizedText: string
  author?: 'user' | 'agent'
  authorLabel?: string | null
  scoreNormalized?: number
}

async function buildMcpThoughtSnippetRows(
  userId: string,
  rows: Array<Omit<McpThoughtSnippetRow, 'snippet'> & { score?: number }>,
  weights: { vector: number; graph: number },
  now: Date,
): Promise<
  Array<{
    id: string
    category: string
    createdAt: string
    author?: 'user' | 'agent'
    authorLabel?: string | null
    owner: ThoughtOwner
    editable: boolean
    snippet: string
    temporalStatus: 'none' | 'active' | 'expired'
    temporalSummary?: string
    scoreNormalized?: number
  }>
> {
  // Temporal context lives with each thought's owner (a co-worker's events follow its thoughts, 0164/0171).
  const idsByOwner = new Map<string, string[]>()
  for (const row of rows) idsByOwner.set(row.ownerId, [...(idsByOwner.get(row.ownerId) ?? []), row.id])
  const contextMaps = await Promise.all(
    [...idsByOwner].map(([ownerId, thoughtIds]) => loadTemporalContextByThoughtIds({ userId: ownerId, thoughtIds, now })),
  )
  const contextByThoughtId = new Map(contextMaps.flatMap((map) => [...map]))
  const owners = await thoughtOwnersOf([...idsByOwner.keys()])

  return rows.map((row) => {
    const ctx = contextByThoughtId.get(row.id)
    const { temporalStatus, temporalSummary } = compactTemporalFieldsForMcp(ctx, now)
    const baseSnippet = thoughtSnippet(row.normalizedText)
    return {
      id: row.id,
      category: row.category,
      createdAt: row.createdAt.toISOString(),
      ...(row.author ? { author: row.author } : {}),
      ...(row.authorLabel ? { authorLabel: row.authorLabel } : {}),
      owner: owners.get(row.ownerId)!,
      editable: row.ownerId === userId,
      temporalStatus,
      ...(temporalSummary ? { temporalSummary } : {}),
      ...(typeof row.score === 'number'
        ? { scoreNormalized: normalizeRetrievalScore(row.score) }
        : {}),
      snippet: enhanceSnippetWithTemporalContext({
        snippet: baseSnippet,
        storedAt: row.createdAt,
        temporalStatus,
        temporalSummary,
      }),
    }
  })
}

export async function runCaptureThoughtTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const raw = typeof body.raw === 'string' ? body.raw : ''
  if (!raw.trim()) {
    throw new Error('raw is required')
  }
  const capturedAt = parseOptionalIsoTimestamp(body.captured_at, 'captured_at')
  const authorPrefix = typeof body.author === 'string' ? body.author : undefined
  const asUser = body.as_user === true
  const authorship = await resolveMcpCaptureAuthorship({
    authorPrefix,
    asUser,
    authenticatedApiKey: context.authenticatedApiKey,
    coworker: context.coworker,
  })
  const stored = await captureThought(context.userId, raw, {
    source: authorship.author === 'agent' ? 'agent' : 'mcp',
    author: authorship.author,
    authorLabel: authorship.authorLabel,
    authorKeyId: authorship.authorKeyId,
    ...(capturedAt ? { capturedAt } : {}),
  })
  return sanitizeMcpToolResult({
    thoughtId: stored.id,
    status: stored.queueStatus ?? 'queued',
    thought: stored,
  })
}

export async function runRetrieveThoughtsTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  const order = parseRetrieveOrder(body)
  const topK = typeof body.top_k === 'number' ? body.top_k : undefined
  const threshold = typeof body.threshold === 'number' ? body.threshold : undefined
  const detail = parseDetailLevel(body)
  const authorFilter = parseThoughtAuthorScope(context, body)
  const reach = parseThoughtReach(body)
  validateSearchParams({ topK, threshold })
  const weights = CONTEXT_WEIGHTS.default
  const effectiveTopK = topK ?? 10

  if (!query || order === 'created_at') {
    if (query && order === 'created_at') {
      // The query is Memory text: its size, never its words.
      console.info('[mcp.tool:retrieve_thoughts] order=created_at ignores query for recent browse', {
        queryChars: query.length,
      })
    }
    const cursorCreatedAt =
      typeof body.cursor_created_at === 'string' ? new Date(body.cursor_created_at) : undefined
    const cursorId = typeof body.cursor_id === 'string' ? body.cursor_id : undefined
    return listRecentThoughtsForMcp(context, {
      limit: effectiveTopK,
      detail,
      cursor:
        cursorCreatedAt && cursorId
          ? {
              createdAt: cursorCreatedAt,
              id: cursorId,
            }
          : undefined,
      weights,
      ...(authorFilter ? { authorFilter } : {}),
      reach,
    })
  }

  const retrieveStart = Date.now()
  console.info('[mcp.tool:retrieve_thoughts] start', {
    queryChars: query.length,
    topK: effectiveTopK,
    threshold: threshold ?? null,
    authorFilter: authorFilter ?? 'all',
    reach,
  })

  context.onToolProgress?.({
    tool: 'retrieve_thoughts',
    phase: 'searching',
    label: 'Searching your memories…',
  })
  const [results, textFiles] = await Promise.all([
    searchThoughts({
      userId: context.userId,
      query,
      topK: effectiveTopK,
      ...(authorFilter ? { authorFilter } : {}),
      reach,
    }),
    // Notes: the person's and colleagues' shared ones, each with its owner.
    searchTextFiles(context.userId, {
      query,
      topK: effectiveTopK,
      ...(authorFilter ? { authorFilter } : {}),
    }).then(withOwners),
  ])
  void tryRecordRetrievalQualityEvent({
    userId: context.userId,
    surface: 'mcp',
    weights,
    topKRequested: effectiveTopK,
    results: results.map((r) => ({ vectorScore: r.vectorScore, graphScore: r.graphScore })),
  })
  const filtered =
    threshold == null
      ? results
      : results.filter((result) => normalizeRetrievalScore(result.score) >= threshold)

  if (detail === 'full') {
    const out = sanitizeMcpToolResult({
      count: filtered.length,
      results: await markThoughtOwners(context.userId, filtered),
      textFiles,
    })
    console.info('[mcp.tool:retrieve_thoughts] done', {
      durationMs: Date.now() - retrieveStart,
      resultCount: filtered.length,
    })
    return out
  }

  const now = new Date()
  const snippetRows = await buildMcpThoughtSnippetRows(
    context.userId,
    filtered.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      category: row.category,
      createdAt: row.createdAt,
      normalizedText: row.normalizedText,
      author: row.author,
      authorLabel: row.authorLabel,
      score: row.score,
    })),
    weights,
    now,
  )

  const out = sanitizeMcpToolResult({
    count: snippetRows.length,
    results: snippetRows,
    textFiles,
  })
  console.info('[mcp.tool:retrieve_thoughts] done', {
    durationMs: Date.now() - retrieveStart,
    resultCount: filtered.length,
  })
  return out
}

export async function runAnswerQuestionTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const question = typeof body.question === 'string' ? body.question.trim() : ''
  if (!question) {
    throw new Error('question is required')
  }
  const topK = typeof body.top_k === 'number' ? body.top_k : undefined
  const referenceTime = parseOptionalIsoTimestamp(body.reference_time, 'reference_time')
  const authorFilter = parseAuthorScope(body)
  const answerStart = Date.now()
  console.info('[mcp.tool:answer_question] start', {
    questionChars: question.length,
    topK: topK ?? null,
  })
  const result = await composeAnswer({
    userId: context.userId,
    question,
    ...(topK != null ? { topK } : {}),
    ...(referenceTime ? { referenceTime } : {}),
    ...(authorFilter ? { authorFilter } : {}),
    onProgress: async (phase) => {
      const labels: Record<string, string> = {
        embedding: 'Embedding your question…',
        searching: 'Searching your memories…',
        composing: 'Composing answer from matches…',
      }
      console.info('[mcp.tool:answer_question] progress', { phase })
      context.onToolProgress?.({
        tool: 'answer_question',
        phase,
        label: labels[phase] ?? 'Working…',
      })
    },
  })
  console.info('[mcp.tool:answer_question] done', {
    durationMs: Date.now() - answerStart,
    citationCount: result.citations.length,
    retrievedCount: result.retrieved.length,
  })
  return sanitizeMcpToolResult(result)
}

export async function runDeleteThoughtTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const thoughtId = readThoughtIdFromToolArgs(body)
  const result = await archiveThoughtForUser(context.userId, thoughtId)
  if (!result.ok) {
    throw new Error('Thought not found')
  }
  return sanitizeMcpToolResult({ archived: true, thoughtId, status: 'archived' })
}

export async function runEditThoughtTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const thoughtId = readThoughtIdFromToolArgs(body)
  const editRequest = typeof body.edit_request === 'string' ? body.edit_request.trim() : ''
  const rawTextReplacement = typeof body.raw_text === 'string' ? body.raw_text : undefined
  if (!editRequest && !rawTextReplacement) {
    throw new Error('edit_request or raw_text is required')
  }

  console.info('[mcp.edit_thought] start', {
    userId: context.userId,
    thoughtId,
    // Edit request and replacement text are Memory text: sizes only.
    editRequestChars: editRequest.length,
    hasRawText: rawTextReplacement !== undefined,
    rawTextChars: rawTextReplacement?.length ?? null,
  })

  try {
    const [existing] = await getDb()
      .select({
        id: thought.id,
        rawText: thought.rawText,
        normalizedText: thought.normalizedText,
        category: thought.category,
        metadata: thought.metadata,
      })
      .from(thought)
      .where(and(eq(thought.id, thoughtId), eq(thought.userId, context.userId)))
      .limit(1)

    if (!existing) {
      console.error('[mcp.edit_thought] not found', { userId: context.userId, thoughtId })
      throw new Error('Thought not found')
    }

    const priorMeta = (existing.metadata as Record<string, unknown>) ?? {}
    const before = {
      thoughtId: existing.id,
      rawText: existing.rawText,
      normalizedText: existing.normalizedText,
      category: existing.category,
      status: typeof priorMeta.status === 'string' ? priorMeta.status : 'open',
    }

    let updated
    if (rawTextReplacement !== undefined) {
      // Direct text replacement bypassing LLM
      const { normalizeThoughtText } = await import('$lib/server/capture/service')
      const { normalized } = normalizeThoughtText(rawTextReplacement)
      const metadataPatch: Record<string, unknown> = {
        ...priorMeta,
        lastEditRequest: editRequest || 'raw_text replacement',
        lastEditSummary: 'Text replaced directly',
      }
      const metadataEncrypted = await encryptTenantValue({
        userId: context.userId,
        table: 'thought',
        column: 'metadata',
        plaintext: JSON.stringify(metadataPatch),
      })
      const rawTextEncrypted = await encryptTenantValue({
        userId: context.userId,
        table: 'thought',
        column: 'raw_text',
        plaintext: rawTextReplacement,
      })
      const normalizedEncrypted = await encryptTenantValue({
        userId: context.userId,
        table: 'thought',
        column: 'normalized_text',
        plaintext: normalized,
      })
      const lexicalText = normalized.toLowerCase()
      const [row] = await getDb()
        .update(thought)
        .set({
          rawText: rawTextReplacement,
          rawTextEncrypted,
          normalizedText: normalized,
          normalizedTextEncrypted: normalizedEncrypted,
          lexicalText,
          metadata: metadataPatch,
          metadataEncrypted,
          updatedAt: new Date(),
        })
        .where(eq(thought.id, thoughtId))
        .returning()
      if (!row) {
        throw new Error('Thought not found')
      }
      // Rewrites the thought's ciphertext: a task of a shared project stays sealed with the company key (shared-memory-keys.ts).
      await reconcileThoughtKeys(context.userId, [thoughtId])
      updated = {
        ok: true as const,
        thought: await (
          await import('$lib/server/capture/capture-result')
        ).loadThoughtCaptureResult(context.userId, thoughtId),
        editSummary: 'Text replaced directly',
      }
    } else {
      updated = await editStoredThought(context.userId, thoughtId, editRequest)
    }
    if (!updated.ok) {
      console.error('[mcp.edit_thought] edit returned not_found', {
        userId: context.userId,
        thoughtId,
      })
      throw new Error('Thought not found')
    }

    const afterMeta = (updated.thought.metadata as Record<string, unknown>) ?? {}
    console.info('[mcp.edit_thought] ok', {
      userId: context.userId,
      thoughtId,
      summaryChars: updated.editSummary.length,
      status: typeof afterMeta.status === 'string' ? afterMeta.status : 'open',
    })

    const { notifyThoughtUpdated } = await import('$lib/server/agents/notify')
    const { loadProjectContextForThought } = await import('$lib/server/agents/project-context')
    const projectCtx = await loadProjectContextForThought(context.userId, updated.thought.id)
    notifyThoughtUpdated({
      userId: context.userId,
      thoughtId: updated.thought.id,
      normalizedText: updated.thought.normalizedText,
      category: updated.thought.category,
      projectEntityIds: projectCtx.projectEntityIds,
      projectLabels: projectCtx.projectLabels,
    })

    return sanitizeMcpToolResult({
      thought: updated.thought,
      thoughtId: updated.thought.id,
      editRequest,
      summary: updated.editSummary,
      before,
      after: {
        normalizedText: updated.thought.normalizedText,
        category: updated.thought.category,
        status: typeof afterMeta.status === 'string' ? afterMeta.status : 'open',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[mcp.edit_thought] failed', {
      userId: context.userId,
      thoughtId,
      message,
      stack: err instanceof Error ? err.stack : undefined,
    })
    throw err
  }
}

/** Whose notes a list/search covers (default 'all': the reader's and colleagues' shared ones). */
function parseTextFileScope(body: Record<string, unknown>): TextFileScope {
  const raw = body.scope
  if (raw === undefined) return 'all'
  if (raw === 'mine' || raw === 'team' || raw === 'all') return raw
  throw new Error('scope must be mine, team or all')
}

/** `private: true` → 'private'; `false` → 'company' (shared with every member). */
function parsePrivateFlag(body: Record<string, unknown>): 'private' | 'company' {
  if (typeof body.private !== 'boolean') throw new Error('private (true or false) is required')
  return body.private ? 'private' : 'company'
}

export async function runCreateTextFileTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const rawBody = typeof body.body === 'string' ? body.body : undefined
  const title = typeof body.title === 'string' ? body.title : undefined
  if (!(title?.trim() || rawBody?.trim())) throw new Error('title or body is required')
  const authorPrefix = typeof body.author === 'string' ? body.author : undefined
  const asUser = body.as_user === true
  const authorship = await resolveMcpCaptureAuthorship({
    authorPrefix,
    asUser,
    authenticatedApiKey: context.authenticatedApiKey,
  })
  const textFile = await createTextFile(context.userId, {
    title,
    body: rawBody,
    authorship,
    visibility: body.private === true ? 'private' : 'company',
  })
  return sanitizeMcpToolResult({ textFileId: textFile.id, textFile })
}

export async function runListTextFilesTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const limit = typeof body.limit === 'number' ? body.limit : undefined
  const cursorUpdatedAt =
    typeof body.cursor_updated_at === 'string' ? body.cursor_updated_at.trim() : ''
  const cursorId = typeof body.cursor_id === 'string' ? body.cursor_id.trim() : ''
  const cursor =
    cursorUpdatedAt && cursorId ? { updatedAt: new Date(cursorUpdatedAt), id: cursorId } : undefined
  if (cursor && Number.isNaN(cursor.updatedAt.getTime())) {
    throw new Error('cursor_updated_at must be a valid ISO timestamp')
  }
  const textFiles = await withOwners(
    await listTextFiles(context.userId, { limit, cursor, scope: parseTextFileScope(body) }),
  )
  return sanitizeMcpToolResult({ count: textFiles.length, textFiles })
}

export async function runGetTextFileTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const textFileId = typeof body.text_file_id === 'string' ? body.text_file_id.trim() : ''
  if (!textFileId) throw new Error('text_file_id is required')
  const found = await getTextFile(context.userId, textFileId)
  if (!found) throw new Error('Text file not found')
  const [textFile] = await withOwners([found])
  return sanitizeMcpToolResult({ textFile })
}

export async function runUpdateTextFileTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const textFileId = typeof body.text_file_id === 'string' ? body.text_file_id.trim() : ''
  if (!textFileId) throw new Error('text_file_id is required')
  const title = typeof body.title === 'string' ? body.title : undefined
  const rawBody = typeof body.body === 'string' ? body.body : undefined
  if (title === undefined && rawBody === undefined) {
    throw new Error('title or body is required')
  }
  const textFile = await updateTextFile(context.userId, textFileId, { title, body: rawBody })
  if (!textFile) throw new Error('Text file not found')
  return sanitizeMcpToolResult({ textFile })
}

export async function runAppendTextFileTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const textFileId = typeof body.text_file_id === 'string' ? body.text_file_id.trim() : ''
  if (!textFileId) throw new Error('text_file_id is required')
  const text = typeof body.text === 'string' ? body.text : ''
  if (!text.trim()) throw new Error('text is required')
  const separator = typeof body.separator === 'string' ? body.separator : undefined
  const textFile = await appendTextFile(context.userId, textFileId, { text, separator })
  if (!textFile) throw new Error('Text file not found')
  return sanitizeMcpToolResult({ textFile })
}

export async function runDeleteTextFileTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const textFileId = typeof body.text_file_id === 'string' ? body.text_file_id.trim() : ''
  if (!textFileId) throw new Error('text_file_id is required')
  const deleted = await deleteTextFile(context.userId, textFileId)
  if (!deleted) throw new Error('Text file not found')
  return sanitizeMcpToolResult({ deleted: true, textFileId })
}

export async function runSearchTextFilesTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const query = typeof body.query === 'string' ? body.query.trim() : ''
  if (!query) throw new Error('query is required')
  const topK = typeof body.top_k === 'number' ? body.top_k : undefined
  const authorFilter = parseAuthorScope(body)
  const results = await withOwners(
    await searchTextFiles(context.userId, {
      query,
      topK,
      scope: parseTextFileScope(body),
      ...(authorFilter ? { authorFilter } : {}),
    }),
  )
  return sanitizeMcpToolResult({ count: results.length, results })
}

/** Make one of the person's notes private (theirs only) or share it with every member. */
export async function runSetTextFileVisibilityTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const textFileId = typeof body.text_file_id === 'string' ? body.text_file_id.trim() : ''
  if (!textFileId) throw new Error('text_file_id is required')
  const result = await setTextFileVisibility(context.userId, textFileId, parsePrivateFlag(body))
  if (!result) throw new Error('Text file not found')
  return sanitizeMcpToolResult(result)
}

/** Make one of the person's projects private (theirs only, tasks included) or share it with every member. */
export async function runSetProjectVisibilityTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityId = validateNonEmptyEntityId(
    typeof body.project_entity_id === 'string' ? body.project_entity_id : '',
    'project_entity_id',
  )
  return sanitizeMcpToolResult(
    await setProjectVisibility(context.userId, projectEntityId, parsePrivateFlag(body)),
  )
}

export async function runLinkTextFileToThoughtTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const thoughtId = typeof body.thought_id === 'string' ? body.thought_id.trim() : ''
  const textFileId = typeof body.text_file_id === 'string' ? body.text_file_id.trim() : ''
  if (!thoughtId) throw new Error('thought_id is required')
  if (!textFileId) throw new Error('text_file_id is required')
  const result = await linkTextFileToThought(context.userId, thoughtId, textFileId)
  if (!result.linked) {
    if (result.reason === 'thought_not_found') throw new Error('Thought not found')
    throw new Error('Text file not found')
  }
  return sanitizeMcpToolResult({ linked: true, thoughtId, textFileId })
}

export async function runUnlinkTextFileFromThoughtTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const thoughtId = typeof body.thought_id === 'string' ? body.thought_id.trim() : ''
  const textFileId = typeof body.text_file_id === 'string' ? body.text_file_id.trim() : ''
  if (!thoughtId) throw new Error('thought_id is required')
  if (!textFileId) throw new Error('text_file_id is required')
  const unlinked = await unlinkTextFileFromThought(context.userId, thoughtId, textFileId)
  if (!unlinked) throw new Error('Attachment link not found')
  return sanitizeMcpToolResult({ unlinked: true, thoughtId, textFileId })
}

/**
 * The person's projects and the projects colleagues share (scope 'all', the
 * default), or one of the two. Each says whose it is and whether the reader
 * may change it; a colleague's project is read-only.
 */
export async function runListProjectsTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const authorScope =
    body.author === 'all' || body.include_agent === true
      ? 'all'
      : body.author === 'agent'
        ? 'all'
        : 'user'
  const scope = body.scope === undefined ? 'all' : body.scope
  if (scope !== 'mine' && scope !== 'team' && scope !== 'all') {
    throw new Error('scope must be mine, team or all')
  }
  const own =
    scope === 'team'
      ? []
      : await (async () => {
          const owner = { id: context.userId, name: await ownerNameOf(context.userId) }
          return (await listProjectsForUser(context.userId, { authorScope })).map((project) => ({
            ...project,
            owner,
            editable: true,
          }))
        })()
  const team = scope === 'mine' ? [] : await listTeamProjects(context.userId)
  const projects = [...own, ...team]
  return sanitizeMcpToolResult({
    count: projects.length,
    projects: projects.map((project) => ({
      entityId: project.entityId,
      label: project.label,
      owner: project.owner,
      editable: project.editable,
      visibility: project.visibility,
      status: project.status,
      source: project.source,
      openTaskCount: project.openTaskCount,
      targetDate: project.targetDate,
      nextAction: project.nextAction,
      tasks: project.tasks,
      milestones: project.milestones,
    })),
  })
}

export async function runGetProjectTimelineTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityIdRaw =
    typeof body.project_entity_id === 'string'
      ? body.project_entity_id
      : typeof body.projectEntityId === 'string'
        ? body.projectEntityId
        : ''
  const projectEntityId = validateNonEmptyEntityId(projectEntityIdRaw, 'project_entity_id')
  // The reader's own project, or a colleague's shared one (read-only); never a private one.
  const access = await resolveProjectAccess(context.userId, projectEntityId)
  if (!access) throw new Error('Project not found')
  const project = access.editable
    ? (await listProjectsForUser(context.userId, { authorScope: 'all' })).find(
        (p) => p.entityId === projectEntityId,
      )
    : await loadProjectForReader(context.userId, access.ownerId, projectEntityId)
  if (!project) throw new Error('Project not found')
  const milestones = await listMilestonesForProject(access.ownerId, projectEntityId)
  return sanitizeMcpToolResult({
    project: {
      entityId: project.entityId,
      label: project.label,
      owner: { id: access.ownerId, name: access.ownerName },
      editable: access.editable,
      visibility: project.visibility,
      status: project.status,
      source: project.source,
      openTaskCount: project.openTaskCount,
      targetDate: project.targetDate,
      nextAction: project.nextAction,
      tasks: project.tasks,
      milestones,
    },
  })
}

export async function runOrderTaskInProjectTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityId = validateNonEmptyEntityId(
    typeof body.project_entity_id === 'string'
      ? body.project_entity_id
      : typeof body.projectEntityId === 'string'
        ? body.projectEntityId
        : '',
    'project_entity_id',
  )
  const thoughtId = validateNonEmptyEntityId(
    typeof body.thought_id === 'string'
      ? body.thought_id
      : typeof body.thoughtId === 'string'
        ? body.thoughtId
        : '',
    'thought_id',
  )
  const afterThoughtIdRaw =
    typeof body.after_thought_id === 'string'
      ? body.after_thought_id
      : typeof body.afterThoughtId === 'string'
        ? body.afterThoughtId
        : body.after_thought_id === null || body.afterThoughtId === null
          ? null
          : undefined
  const rankRaw = body.rank
  const rank =
    typeof rankRaw === 'number' && Number.isFinite(rankRaw) ? Math.floor(rankRaw) : undefined

  const result = await orderTaskInProject({
    userId: context.userId,
    projectEntityId,
    thoughtId,
    afterThoughtId: afterThoughtIdRaw,
    rank,
  })
  return sanitizeMcpToolResult(result)
}

export async function runSetProjectMilestoneTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityId = validateNonEmptyEntityId(
    typeof body.project_entity_id === 'string'
      ? body.project_entity_id
      : typeof body.projectEntityId === 'string'
        ? body.projectEntityId
        : '',
    'project_entity_id',
  )
  const label = typeof body.label === 'string' ? body.label : ''
  const milestoneId =
    typeof body.milestone_id === 'string'
      ? body.milestone_id
      : typeof body.milestoneId === 'string'
        ? body.milestoneId
        : undefined
  const targetDate =
    typeof body.target_date === 'string'
      ? body.target_date
      : typeof body.targetDate === 'string'
        ? body.targetDate
        : body.target_date === null || body.targetDate === null
          ? null
          : undefined
  const linkedThoughtId =
    typeof body.linked_thought_id === 'string'
      ? body.linked_thought_id
      : typeof body.linkedThoughtId === 'string'
        ? body.linkedThoughtId
        : body.linked_thought_id === null || body.linkedThoughtId === null
          ? null
          : undefined
  const rank = typeof body.rank === 'number' && Number.isFinite(body.rank) ? body.rank : undefined
  const completed = typeof body.completed === 'boolean' ? body.completed : undefined

  const milestone = await setProjectMilestone({
    userId: context.userId,
    projectEntityId,
    ...(milestoneId ? { milestoneId } : {}),
    label,
    ...(targetDate !== undefined ? { targetDate } : {}),
    ...(linkedThoughtId !== undefined ? { linkedThoughtId } : {}),
    ...(rank !== undefined ? { rank } : {}),
    ...(completed !== undefined ? { completed } : {}),
  })
  return sanitizeMcpToolResult({ milestone })
}

export async function runSetProjectDeadlineTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityId = validateNonEmptyEntityId(
    typeof body.project_entity_id === 'string'
      ? body.project_entity_id
      : typeof body.projectEntityId === 'string'
        ? body.projectEntityId
        : '',
    'project_entity_id',
  )
  const targetDateRaw =
    typeof body.target_date === 'string'
      ? body.target_date
      : typeof body.targetDate === 'string'
        ? body.targetDate
        : body.target_date === null || body.targetDate === null
          ? null
          : undefined
  if (targetDateRaw === undefined) {
    throw new Error('target_date is required (ISO-8601 string or null)')
  }
  const result = await setProjectDeadline({
    userId: context.userId,
    projectEntityId,
    targetDate: targetDateRaw,
  })
  return sanitizeMcpToolResult(result)
}

export async function runGenerateProjectPlanTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityId = validateNonEmptyEntityId(
    typeof body.project_entity_id === 'string'
      ? body.project_entity_id
      : typeof body.projectEntityId === 'string'
        ? body.projectEntityId
        : '',
    'project_entity_id',
  )
  const goal =
    typeof body.goal === 'string' && body.goal.trim() ? body.goal.trim() : undefined

  const result = await generateProjectPlan({
    userId: context.userId,
    projectEntityId,
    ...(goal ? { goal } : {}),
  })
  return sanitizeMcpToolResult(result)
}

export async function runCreateProjectTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const label = typeof body.label === 'string' ? body.label.trim() : ''
  if (!label) {
    throw new Error('label is required')
  }
  const statusRaw = typeof body.status === 'string' ? body.status : 'active'
  const validStatuses = ['active', 'someday'] as const
  const status = validStatuses.includes(statusRaw as 'active' | 'someday')
    ? (statusRaw as 'active' | 'someday')
    : 'active'

  // Project names are Memory text: logs carry ids and sizes, never the name.
  console.info('[mcp.tool:create_project] start', { labelChars: label.length, status })

  const result = await createProject(context.userId, label, { status })

  console.info('[mcp.tool:create_project] done', {
    entityId: result.entityId,
    status: result.status,
  })

  return sanitizeMcpToolResult(result)
}

export async function runEditProjectTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityId = validateNonEmptyEntityId(
    typeof body.project_entity_id === 'string'
      ? body.project_entity_id
      : typeof body.projectEntityId === 'string'
        ? body.projectEntityId
        : '',
    'project_entity_id',
  )
  const label = typeof body.label === 'string' ? body.label.trim() : undefined
  const statusRaw = typeof body.status === 'string' ? body.status : undefined

  if (!label && !statusRaw) {
    throw new Error('At least one of label or status is required')
  }

  console.info('[mcp.tool:edit_project] start', {
    projectEntityId,
    labelChars: label?.length ?? null,
    status: statusRaw ?? null,
  })

  const updates: { entityId: string; label?: string; status?: string } = {
    entityId: projectEntityId,
  }

  if (label) {
    const labelResult = await updateProjectLabel(context.userId, projectEntityId, label)
    updates.label = labelResult.label
  }

  if (statusRaw) {
    const validStatuses = ['active', 'someday', 'completed'] as const
    const status = validStatuses.includes(statusRaw as 'active' | 'someday' | 'completed')
      ? (statusRaw as 'active' | 'someday' | 'completed')
      : undefined
    if (!status) {
      throw new Error(`Invalid status: ${statusRaw}. Must be active, someday, or completed.`)
    }
    const statusResult = await updateProjectStatus(context.userId, projectEntityId, status)
    updates.status = statusResult.status
  }

  console.info('[mcp.tool:edit_project] done', {
    entityId: updates.entityId,
    labelChanged: updates.label !== undefined,
    status: updates.status ?? null,
  })

  return sanitizeMcpToolResult(updates)
}

export async function runDeleteProjectTool(context: McpToolContext, args: unknown) {
  const body = asObject(args)
  const projectEntityId = validateNonEmptyEntityId(
    typeof body.project_entity_id === 'string'
      ? body.project_entity_id
      : typeof body.projectEntityId === 'string'
        ? body.projectEntityId
        : '',
    'project_entity_id',
  )

  console.info('[mcp.tool:delete_project] start', { projectEntityId })

  // Verify project exists before dismissing
  const projects = await listProjectsForUser(context.userId, { authorScope: 'all' })
  const project = projects.find((p) => p.entityId === projectEntityId)
  if (!project) {
    throw new Error('Project not found')
  }

  await dismissProject(context.userId, projectEntityId)

  console.info('[mcp.tool:delete_project] done', {
    entityId: projectEntityId,
  })

  return sanitizeMcpToolResult({
    deleted: true,
    entityId: projectEntityId,
    label: project.label,
  })
}
