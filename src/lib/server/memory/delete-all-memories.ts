import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import {
  DELETE_ALL_MEMORIES_CONFIRMATION,
  isDeleteAllMemoriesConfirmation,
} from '$lib/memory/delete-confirmation'
import { WEBHOOK_DELIVERY_JOB } from '$lib/server/agents/constants'
import { getDb } from '$lib/server/db'
import {
  captureSession,
  canonicalEntity,
  graphCommunity,
  graphSyncJob,
  memoryDocument,
  ontologyProposal,
  retrievalQualityEvent,
  textFile,
  thought,
  userGroundingProfile,
  userJobQueue,
  userOntology,
  webhookDelivery,
} from '$lib/server/db/schema'
import { deleteAllUserGraphVertices } from '$lib/server/graph/age'
import { notSystemProjectTask } from '$lib/server/memory/system-projects'

export type DeleteAllMemoriesResult = {
  thoughtsDeleted: number
  entitiesDeleted: number
  notesDeleted: number
}

/** Webhook events that carried the person's thoughts (or tasks) to a connected agent. */
const MEMORY_WEBHOOK_EVENTS = [
  'thought.created',
  'thought.enriched',
  'thought.updated',
  'thought.deleted',
  'agent.task.assigned',
] as const

export function assertDeleteAllMemoriesConfirmation(confirmation: string): void {
  if (!isDeleteAllMemoriesConfirmation(confirmation)) {
    throw new Error(
      `Confirmation must exactly match: ${JSON.stringify(DELETE_ALL_MEMORIES_CONFIRMATION)}`,
    )
  }
}

/**
 * Removes everything the person put in Memory and wipes their AGE graph:
 * thoughts (with their dates, reminders, links and embeddings), capture
 * sessions, entities and projects, communities and their AI summaries, notes,
 * what check-ins learned about them (grounding facets + narrative), ontology
 * proposals/profile, and the webhook deliveries that carried their thoughts.
 * Does not delete auth, preferences, LLM config, API keys, chat history or the
 * AI usage log. Keeps the company's system projects (the Roadmap) and their
 * tasks — they live in this Memory but are not the person's memories.
 */
export async function deleteAllMemoriesForUser(userId: string): Promise<DeleteAllMemoriesResult> {
  const db = getDb()
  const ownThoughts = and(eq(thought.userId, userId), notSystemProjectTask(userId))
  const ownEntities = and(eq(canonicalEntity.userId, userId), isNull(canonicalEntity.systemKey))

  const counts = await db.transaction(async (tx) => {
    const thoughtRows = await tx.select({ id: thought.id }).from(thought).where(ownThoughts)
    const entityRows = await tx
      .select({ id: canonicalEntity.id })
      .from(canonicalEntity)
      .where(ownEntities)

    await tx.delete(graphSyncJob).where(eq(graphSyncJob.userId, userId))
    await tx.delete(graphCommunity).where(eq(graphCommunity.userId, userId))
    await tx.delete(thought).where(ownThoughts)
    await tx.delete(canonicalEntity).where(ownEntities)
    await tx.delete(captureSession).where(eq(captureSession.userId, userId))
    // Documents are Drive files (drizzle/0191): the brain forgets them here, their files go to
    // the Drive trash below; the old text_file rows (not dropped yet) go with them.
    const noteRows = await tx
      .delete(memoryDocument)
      .where(eq(memoryDocument.userId, userId))
      .returning({ id: memoryDocument.driveFileId, copiedFrom: memoryDocument.textFileId })
    const copied = new Set(noteRows.map((r) => r.copiedFrom))
    // Old notes the startup copy has not reached yet count as notes too.
    const oldOnly = (
      await tx.delete(textFile).where(eq(textFile.userId, userId)).returning({ id: textFile.id })
    ).filter((r) => !copied.has(r.id))
    const deliveries = await tx
      .delete(webhookDelivery)
      .where(
        and(
          eq(webhookDelivery.userId, userId),
          inArray(webhookDelivery.eventType, [...MEMORY_WEBHOOK_EVENTS]),
        ),
      )
      .returning({ id: webhookDelivery.id })
    if (deliveries.length > 0) {
      await tx.delete(userJobQueue).where(
        and(
          eq(userJobQueue.userId, userId),
          eq(userJobQueue.jobType, WEBHOOK_DELIVERY_JOB),
          eq(userJobQueue.status, 'pending'),
          inArray(
            sql<string>`${userJobQueue.payload} ->> 'deliveryId'`,
            deliveries.map((row) => row.id),
          ),
        ),
      )
    }
    await tx
      .update(userGroundingProfile)
      .set({ narrativeSummaryEncrypted: null, facets: {}, pendingCheckIn: null })
      .where(eq(userGroundingProfile.userId, userId))
    await tx.delete(retrievalQualityEvent).where(eq(retrievalQualityEvent.userId, userId))
    await tx.delete(ontologyProposal).where(eq(ontologyProposal.userId, userId))
    await tx
      .update(userOntology)
      .set({ profile: {}, evaluatedUpToThoughtCount: 0, updatedAt: new Date() })
      .where(eq(userOntology.userId, userId))

    return {
      thoughtsDeleted: thoughtRows.length,
      entitiesDeleted: entityRows.length,
      notesDeleted: noteRows.length + oldOnly.length,
      documentFileIds: noteRows.map((r) => r.id),
    }
  })

  if (counts.documentFileIds.length > 0) {
    const { driveService } = await import('../../../../modules/drive')
    const drive = await driveService()
    for (const id of counts.documentFileIds) {
      try {
        await drive.moveToTrash({ kind: 'user', userId }, 'file', id)
      } catch (err) {
        // Already trashed or deleted in Drive.
        if ((err as { code?: string }).code !== 'not_found') throw err
      }
    }
  }

  await deleteAllUserGraphVertices(userId)

  return {
    thoughtsDeleted: counts.thoughtsDeleted,
    entitiesDeleted: counts.entitiesDeleted,
    notesDeleted: counts.notesDeleted,
  }
}
