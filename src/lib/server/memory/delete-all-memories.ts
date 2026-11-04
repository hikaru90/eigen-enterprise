import { and, eq, isNull } from 'drizzle-orm'
import {
  DELETE_ALL_MEMORIES_CONFIRMATION,
  isDeleteAllMemoriesConfirmation,
} from '$lib/memory/delete-confirmation'
import { getDb } from '$lib/server/db'
import {
  captureSession,
  canonicalEntity,
  graphCommunity,
  graphSyncJob,
  ontologyProposal,
  retrievalQualityEvent,
  thought,
  userOntology,
} from '$lib/server/db/schema'
import { deleteAllUserGraphVertices } from '$lib/server/graph/age'
import { notSystemProjectTask } from '$lib/server/memory/system-projects'

export type DeleteAllMemoriesResult = {
  thoughtsDeleted: number
  entitiesDeleted: number
}

export function assertDeleteAllMemoriesConfirmation(confirmation: string): void {
  if (!isDeleteAllMemoriesConfirmation(confirmation)) {
    throw new Error(
      `Confirmation must exactly match: ${JSON.stringify(DELETE_ALL_MEMORIES_CONFIRMATION)}`,
    )
  }
}

/**
 * Removes all semantic memory rows for the tenant and wipes their AGE graph.
 * Does not delete auth, preferences, LLM config, API keys, or chat history.
 * Keeps the company's system projects (the Roadmap) and their tasks — they
 * live in this Memory but are not the person's memories.
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
    await tx.delete(retrievalQualityEvent).where(eq(retrievalQualityEvent.userId, userId))
    await tx.delete(ontologyProposal).where(eq(ontologyProposal.userId, userId))
    await tx
      .update(userOntology)
      .set({ profile: {}, evaluatedUpToThoughtCount: 0, updatedAt: new Date() })
      .where(eq(userOntology.userId, userId))

    return {
      thoughtsDeleted: thoughtRows.length,
      entitiesDeleted: entityRows.length,
    }
  })

  await deleteAllUserGraphVertices(userId)

  return counts
}
