/**
 * Tier 2: enrich a queued thought row in place using full user context.
 */
import { and, eq, sql } from 'drizzle-orm'
import { applyCaptureContentSplitIfNeeded } from '$lib/server/capture/apply-capture-content-split'
import { enrichThought, type EnrichThoughtOptions } from '$lib/server/capture/enrich'
import { drainCaptureEnrichQueue } from '$lib/server/capture/enrich-queue-drain'
import { extractEnrichThoughtBundle } from '$lib/server/capture/enrich-thought-bundle'
import {
  loadEnrichmentContext,
  type EnrichmentContext,
} from '$lib/server/capture/enrichment-context'
import {
  createIngestPhaseTimer,
  logIngestPhaseTiming,
  type IngestPhaseTimer,
} from '$lib/server/capture/phase-timing'
import { markEnrichQueueComplete, markEnrichQueueFailed } from '$lib/server/capture/queue-capture'
import { toPgVectorLiteral } from '$lib/server/capture/service'
import type { CaptureProgressEvent } from '$lib/server/capture/service'
import { decryptTenantValue, encryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { getDb } from '$lib/server/db'
import { thought } from '$lib/server/db/schema'
import { runIngestWithRetries } from '$lib/server/ingest/retry'
import { createThoughtEmbedding } from '$lib/server/llm/embedding'
import {
  extractEntityGraphBundle,
  shouldRetryEntityMentionExtraction,
  type ExtractedEntityMention,
  type ExtractedEntityTriple,
} from '$lib/server/memory/entity-extraction'
import type { EntityGraphEnrichmentContext } from '$lib/server/memory/entity-graph-enrichment-context'
import { loadEntityGraphEnrichmentContext } from '$lib/server/memory/entity-graph-enrichment-context'
import { reconcileThoughtKeys } from '$lib/server/memory/shared-memory-keys'
import type { ExtractedTemporalMention } from '$lib/server/memory/temporal-normalize'
import { getUserPreferredTimezone } from '$lib/server/memory/user-timezone'
import { isGraphScaleQuiet } from '$lib/server/observability/graph-scale-quiet'
import type { ResolvedThoughtOntologyKind } from '$lib/server/ontology/classify-thought-category'

export type EnrichQueuedThoughtOptions = {
  onProgress?: (event: CaptureProgressEvent) => Promise<void>
  ingestTimer?: IngestPhaseTimer
  /** Pre-loaded context (tests). */
  context?: EnrichmentContext
}

async function decryptQueuedRow(
  userId: string,
  row: {
    rawText: string
    normalizedText: string
    rawTextEncrypted: string | null
    normalizedTextEncrypted: string | null
  },
): Promise<{ rawText: string; normalizedText: string }> {
  const [rawText, normalizedText] = await Promise.all([
    row.rawTextEncrypted
      ? decryptTenantValue({
          userId,
          table: 'thought',
          column: 'raw_text',
          ciphertext: row.rawTextEncrypted,
        })
      : Promise.resolve(row.rawText),
    row.normalizedTextEncrypted
      ? decryptTenantValue({
          userId,
          table: 'thought',
          column: 'normalized_text',
          ciphertext: row.normalizedTextEncrypted,
        })
      : Promise.resolve(row.normalizedText),
  ])
  return { rawText, normalizedText }
}

async function prefetchEnrichExtractions(input: {
  context: EnrichmentContext
  capturedAt: Date
}): Promise<{
  category: ResolvedThoughtOntologyKind
  embedding: number[]
  entityGraph: { mentions: ExtractedEntityMention[]; triples: ExtractedEntityTriple[] }
  entityEnrichmentContext?: EntityGraphEnrichmentContext
  cues: string[]
  temporalMentions: ExtractedTemporalMention[]
}> {
  const { context, capturedAt } = input
  const userId = context.userId
  const { normalizedText } = context

  const ontologyEntityKinds = context.ontology.entityKinds
    .filter((k) => k.active && k.kindType === 'entity_type')
    .map((k) => ({ key: k.key, name: k.name, definition: k.definition }))

  const anchorTimezone = await getUserPreferredTimezone(userId)

  if (isGraphScaleQuiet()) {
    console.info('[graph-scale] enrich prefetch: embedding')
  }
  const embedding = await createThoughtEmbedding(userId, normalizedText)

  let entityEnrichmentContext: EntityGraphEnrichmentContext | undefined
  if (ontologyEntityKinds.length > 0) {
    if (isGraphScaleQuiet()) {
      console.info('[graph-scale] enrich prefetch: entity context')
    }
    entityEnrichmentContext = await loadEntityGraphEnrichmentContext({
      userId,
      normalizedText,
      thoughtEmbedding: embedding,
      communityExcerpts: context.communityExcerpts,
      groundingProfile: context.groundingProfile,
    })
  }

  if (isGraphScaleQuiet()) {
    console.info('[graph-scale] enrich prefetch: enrich_thought_bundle')
  }
  const bundle = await extractEnrichThoughtBundle({
    context,
    capturedAt,
    timezone: anchorTimezone,
    entityEnrichmentContext,
    ontologyEntityKinds,
  })

  let entityGraph = bundle.entityGraph
  if (
    entityGraph.mentions.length === 0 &&
    shouldRetryEntityMentionExtraction(normalizedText) &&
    ontologyEntityKinds.length > 0 &&
    entityEnrichmentContext
  ) {
    console.warn('[enrich-queued] bundle returned zero mentions; entity-only fallback', {
      userId,
      textLen: normalizedText.trim().length,
    })
    entityGraph = await extractEntityGraphBundle({
      userId,
      normalizedText,
      ontologyEntityKinds,
      enrichmentContext: entityEnrichmentContext,
    })
  }

  return {
    category: bundle.category,
    embedding,
    entityGraph,
    entityEnrichmentContext,
    cues: bundle.cues,
    temporalMentions: bundle.temporalMentions,
  }
}

/**
 * Full enrich pipeline for one queued row: context → classify/embed → graph enrich.
 */
export async function enrichQueuedThought(
  userId: string,
  thoughtId: string,
  options?: EnrichQueuedThoughtOptions,
): Promise<void> {
  await enrichQueuedThoughtUnsealed(userId, thoughtId, options)
  // Enrichment sets the category and project links and rewrites metadata: the key follows (shared-memory-keys.ts).
  await reconcileThoughtKeys(userId, [thoughtId])
}

async function enrichQueuedThoughtUnsealed(
  userId: string,
  thoughtId: string,
  options?: EnrichQueuedThoughtOptions,
): Promise<void> {
  const onProgress = options?.onProgress
  const ingestTimer = options?.ingestTimer ?? createIngestPhaseTimer()
  const time = ingestTimer.time.bind(ingestTimer)

  try {
    await runIngestWithRetries(async () => {
      if (isGraphScaleQuiet()) {
        console.info('[graph-scale] enrich pipeline start', { userId, thoughtId })
      }
      const db = getDb()
      const [row] = await db
        .select({
          id: thought.id,
          rawText: thought.rawText,
          normalizedText: thought.normalizedText,
          rawTextEncrypted: thought.rawTextEncrypted,
          normalizedTextEncrypted: thought.normalizedTextEncrypted,
          createdAt: thought.createdAt,
        })
        .from(thought)
        .where(and(eq(thought.id, thoughtId), eq(thought.userId, userId)))
        .limit(1)

      if (!row) {
        throw new Error(`Queued thought not found: ${thoughtId}`)
      }

      const { rawText, normalizedText } = await decryptQueuedRow(userId, row)

      await onProgress?.({ parallel: false, phase: 'content_split' })
      const splitApplied = await time('content_split', () =>
        applyCaptureContentSplitIfNeeded({
          userId,
          thoughtId,
          rawText,
          existingNormalizedText: normalizedText,
        }),
      )

      const context =
        options?.context ??
        (await time('load_enrichment_context', () =>
          loadEnrichmentContext({
            userId,
            thoughtId,
            normalizedText: splitApplied.normalizedText,
            rawText: splitApplied.rawText,
          }),
        ))

      await onProgress?.({ parallel: false, phase: 'ontology' })
      await onProgress?.({ parallel: false, phase: 'embedding' })

      const prefetched = await time('prefetch_enrich_llm', () =>
        prefetchEnrichExtractions({ context, capturedAt: row.createdAt }),
      )

      const {
        key: category,
        ontologyEntityKindId,
        confidence: categoryConfidence,
        alternatives: categoryAlternatives,
      } = prefetched.category

      await time('persist_classify_embed', async () => {
        const metadata = await loadThoughtMetadata(userId, thoughtId)
        // The person picked the category when they captured it (e.g. Tasks › Add a
        // task): it stays; the model's guess never overrides a person's choice.
        const personChoseCategory = metadata.categorySource === 'person'
        await db
          .update(thought)
          .set({
            ...(personChoseCategory ? {} : { category, ontologyEntityKindId }),
            embedding: sql`${toPgVectorLiteral(prefetched.embedding)}::vector`,
            metadataEncrypted: await encryptMetadata(userId, {
              ...metadata,
              ...(personChoseCategory
                ? {}
                : { categorySource: 'llm', categoryConfidence, categoryAlternatives }),
              enrichmentContext: context.completeness,
            }),
          })
          .where(eq(thought.id, thoughtId))
      })

      const [countRow] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(thought)
        .where(eq(thought.userId, userId))
      const thoughtCountAfterInsert = Number(countRow?.n ?? 0)

      const enrichOpts: EnrichThoughtOptions = {
        onProgress,
        thoughtEmbedding: prefetched.embedding,
        thoughtCountAfterInsert,
        preloadedKnownEntities: context.knownEntities,
        precomputedEntityGraph: prefetched.entityGraph,
        precomputedEntityEnrichmentContext: prefetched.entityEnrichmentContext,
        precomputedCues: prefetched.cues,
        precomputedTemporalMentions: prefetched.temporalMentions,
        ingestTimer,
        deferRelations: true,
      }

      await enrichThought(userId, thoughtId, splitApplied.normalizedText, enrichOpts)

      const [enrichedRow] = await getDb()
        .select({ enrichedAt: thought.enrichedAt })
        .from(thought)
        .where(and(eq(thought.id, thoughtId), eq(thought.userId, userId)))
        .limit(1)
      if (!enrichedRow?.enrichedAt) {
        throw new Error('Enrichment finished without setting enriched_at')
      }
    })

    await markEnrichQueueComplete(thoughtId)

    const [enrichedThought] = await getDb()
      .select({
        normalizedText: thought.normalizedText,
        category: thought.category,
        enrichedAt: thought.enrichedAt,
      })
      .from(thought)
      .where(and(eq(thought.id, thoughtId), eq(thought.userId, userId)))
      .limit(1)

    if (enrichedThought?.enrichedAt) {
      const { notifyThoughtEnriched } = await import('$lib/server/agents/notify')
      const { loadProjectContextForThought } = await import('$lib/server/agents/project-context')
      const projectCtx = await loadProjectContextForThought(userId, thoughtId)
      notifyThoughtEnriched({
        userId,
        thoughtId,
        normalizedText: enrichedThought.normalizedText,
        category: enrichedThought.category,
        enrichedAt: enrichedThought.enrichedAt,
        projectEntityIds: projectCtx.projectEntityIds,
        projectLabels: projectCtx.projectLabels,
      })
    }

    logIngestPhaseTiming({
      userId,
      thoughtId,
      timing: ingestTimer.finish(),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!isGraphScaleQuiet()) {
      console.error('[enrich-queued] failed', { userId, thoughtId, message })
    } else {
      console.error('[graph-scale] enrich failed', { userId, thoughtId, message })
    }
    await markEnrichQueueFailed(thoughtId, message)
    throw err
  }
}

async function loadThoughtMetadata(
  userId: string,
  thoughtId: string,
): Promise<Record<string, unknown>> {
  const db = getDb()
  const [existing] = await db
    .select({ metadata: thought.metadata, metadataEncrypted: thought.metadataEncrypted })
    .from(thought)
    .where(eq(thought.id, thoughtId))
    .limit(1)

  if (existing?.metadataEncrypted) {
    const json = await decryptTenantValue({
      userId,
      table: 'thought',
      column: 'metadata',
      ciphertext: existing.metadataEncrypted,
    })
    return JSON.parse(json) as Record<string, unknown>
  }
  if (existing?.metadata && typeof existing.metadata === 'object') {
    return { ...(existing.metadata as Record<string, unknown>) }
  }
  return {}
}

function encryptMetadata(userId: string, metadata: Record<string, unknown>): Promise<string> {
  return encryptTenantValue({
    userId,
    table: 'thought',
    column: 'metadata',
    plaintext: JSON.stringify(metadata),
  })
}

/** Drain all pending rows for a user (eval / admin). */
export async function processCaptureEnrichQueue(
  userId: string,
  options?: import('$lib/server/capture/enrich-queue-drain').DrainCaptureEnrichQueueOptions,
): Promise<number> {
  return drainCaptureEnrichQueue(userId, options)
}
