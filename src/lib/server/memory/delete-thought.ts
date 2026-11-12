import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import { WEBHOOK_DELIVERY_JOB } from '$lib/server/agents/constants'
import { getDb } from '$lib/server/db'
import {
  agentTaskAssignment,
  canonicalEntity,
  communityMember,
  communitySummary,
  temporalEvent,
  thought,
  thoughtEntity,
  userJobQueue,
  webhookDelivery,
} from '$lib/server/db/schema'
import { removeThoughtGraphArtifacts } from '$lib/server/graph/age'
import { pruneCanonicalEntitiesWithNoThoughtLinks } from '$lib/server/memory/canonical-entity-admin'
import { notSystemProjectTask } from '$lib/server/memory/system-projects'

export type DeleteThoughtResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'system_project_task'; projectLabel: string }

/** Webhook events whose payload carries a thought's text (thought.deleted carries only its id). */
const THOUGHT_TEXT_EVENTS = ['thought.created', 'thought.enriched', 'thought.updated'] as const

/**
 * Deletes one of the person's thoughts for good — the Memory "Delete", not an
 * archive. Removes, in this order:
 * - its AGE graph vertex, edges and linked Event vertices;
 * - the AI community summaries whose input included it (they are rebuilt from
 *   what remains at the next consolidation — a missing summary is "pending");
 * - webhook deliveries (and their queued jobs) that carried its text to a
 *   connected agent;
 * - the Postgres row — text, embedding and search index live on it — which
 *   cascades its capture session (raw input, 0128), dates and reminders,
 *   entity/relation links, task order and agent assignments;
 * - entities that no other thought mentions (pruneCanonicalEntitiesWithNoThoughtLinks).
 * Connected agents then get `thought.deleted`. A task of a company system
 * project (the Roadmap) is refused: the board owns it.
 */
export async function deleteThoughtForUser(
  userId: string,
  thoughtId: string,
): Promise<DeleteThoughtResult> {
  const db = getDb()
  const [existing] = await db
    .select({ id: thought.id })
    .from(thought)
    .where(and(eq(thought.id, thoughtId), eq(thought.userId, userId)))
    .limit(1)
  if (!existing) return { ok: false, reason: 'not_found' }

  const [system] = await db
    .select({ label: canonicalEntity.label })
    .from(thoughtEntity)
    .innerJoin(canonicalEntity, eq(canonicalEntity.id, thoughtEntity.entityId))
    .where(
      and(
        eq(thoughtEntity.userId, userId),
        eq(thoughtEntity.thoughtId, existing.id),
        isNotNull(canonicalEntity.systemKey),
      ),
    )
    .limit(1)
  if (system) return { ok: false, reason: 'system_project_task', projectLabel: system.label }

  const linkedEntityIds = (
    await db
      .select({ entityId: thoughtEntity.entityId })
      .from(thoughtEntity)
      .where(and(eq(thoughtEntity.userId, userId), eq(thoughtEntity.thoughtId, existing.id)))
  ).map((row) => row.entityId)

  const temporalEventGraphIds = (
    await db
      .select({ id: temporalEvent.id, graphNodeId: temporalEvent.graphNodeId })
      .from(temporalEvent)
      .where(and(eq(temporalEvent.userId, userId), eq(temporalEvent.thoughtId, existing.id)))
  ).map((row) => row.graphNodeId?.trim() || row.id)

  const assignmentIds = (
    await db
      .select({ id: agentTaskAssignment.id })
      .from(agentTaskAssignment)
      .where(
        and(eq(agentTaskAssignment.userId, userId), eq(agentTaskAssignment.thoughtId, existing.id)),
      )
  ).map((row) => row.id)

  // Community summaries are written from the thoughts of their member entities.
  const communityIds =
    linkedEntityIds.length === 0
      ? []
      : (
          await db
            .selectDistinct({ id: communityMember.communityId })
            .from(communityMember)
            .where(
              and(
                eq(communityMember.userId, userId),
                inArray(communityMember.canonicalEntityId, linkedEntityIds),
              ),
            )
        ).map((row) => row.id)

  const { loadProjectContextForThought } = await import('$lib/server/agents/project-context')
  const projectCtx = await loadProjectContextForThought(userId, existing.id)

  await removeThoughtGraphArtifacts({ userId, thoughtId: existing.id, temporalEventGraphIds })

  await db.transaction(async (tx) => {
    if (communityIds.length > 0) {
      await tx
        .delete(communitySummary)
        .where(
          and(
            eq(communitySummary.userId, userId),
            inArray(communitySummary.communityId, communityIds),
          ),
        )
    }

    const deliveries = await tx
      .delete(webhookDelivery)
      .where(
        and(
          eq(webhookDelivery.userId, userId),
          sql`(
            (${webhookDelivery.eventId} = ${existing.id}
              and ${inArray(webhookDelivery.eventType, [...THOUGHT_TEXT_EVENTS])})
            or (${webhookDelivery.eventType} = 'agent.task.assigned'
              and ${assignmentIds.length > 0 ? inArray(webhookDelivery.eventId, assignmentIds) : sql`false`})
          )`,
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

    await tx.delete(thought).where(and(eq(thought.id, existing.id), eq(thought.userId, userId)))
  })

  await pruneCanonicalEntitiesWithNoThoughtLinks(userId, linkedEntityIds)

  const { notifyThoughtDeleted } = await import('$lib/server/agents/notify')
  notifyThoughtDeleted({
    userId,
    thoughtId: existing.id,
    projectEntityIds: projectCtx.projectEntityIds,
    projectLabels: projectCtx.projectLabels,
  })

  return { ok: true }
}

/** The person's archived thoughts — hidden from Memory's lists but still stored. */
function archivedThoughts(userId: string) {
  return and(
    eq(thought.userId, userId),
    eq(thought.lifecycleStatus, 'archived'),
    notSystemProjectTask(userId),
  )
}

export async function countArchivedThoughts(userId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(thought)
    .where(archivedThoughts(userId))
  return row?.n ?? 0
}

/**
 * Deletes every archived thought for good (Memory → Settings). Until Delete
 * removed things for good, "Delete" archived them, so these are often thoughts
 * the person already believes gone. One deleteThoughtForUser each: the same
 * derived-data cleanup as a single Delete.
 */
export async function deleteArchivedThoughtsForUser(userId: string): Promise<{ deleted: number }> {
  const rows = await getDb()
    .select({ id: thought.id })
    .from(thought)
    .where(archivedThoughts(userId))
  let deleted = 0
  for (const row of rows) {
    const result = await deleteThoughtForUser(userId, row.id)
    if (!result.ok) {
      throw new Error(`Archived thought ${row.id} could not be deleted: ${result.reason}`)
    }
    deleted++
  }
  return { deleted }
}
