import { and, eq, isNull, sql } from 'drizzle-orm'
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
  const notSystemProjectTask = sql`${thought.id} not in (
    select te.thought_id from thought_entity te
    join canonical_entity ce on ce.id = te.entity_id
    where te.user_id = ${userId} and ce.system_key is not null)`
  const ownThoughts = and(eq(thought.userId, userId), notSystemProjectTask)
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
