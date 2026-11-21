import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { canonicalEntity } from '$lib/server/db/schema'
import { ownerNamesOf, type MemoryOwner } from '$lib/server/memory/memory-owners'
import { listProjects, listProjectsByEntityIds, type ProjectListItem } from '$lib/server/memory/project-list'

/**
 * Colleagues' shared projects (plan/shared-memory-voice-agent-tools.md §1).
 * Every loader here calls the owner-parameterised project services with the
 * OWNER's id inside the READER's session: row-level security (drizzle/0164)
 * trims the result to what the owner shares — the project, its tasks (task
 * thoughts linked to it), their order, milestones and dates — and the company
 * key opens what it reads. Nothing here can reach a private project or thought.
 */
export type ProjectForReader = ProjectListItem & { owner: MemoryOwner; editable: boolean }

/** Every live project colleagues share with the reader (system projects such as the Roadmap are pinned elsewhere). */
export async function listTeamProjects(readerId: string): Promise<ProjectForReader[]> {
  const owners = await getDb()
    .selectDistinct({ userId: canonicalEntity.userId })
    .from(canonicalEntity)
    .where(
      and(
        ne(canonicalEntity.userId, readerId),
        eq(canonicalEntity.visibility, 'company'),
        inArray(canonicalEntity.projectStatus, ['active', 'someday']),
        isNull(canonicalEntity.systemKey),
      ),
    )
  if (owners.length === 0) return []
  const names = await ownerNamesOf(owners.map((o) => o.userId))
  const out: ProjectForReader[] = []
  for (const { userId } of owners) {
    const projects = await listProjects(userId, { kind: 'all' })
    for (const project of projects) {
      // RLS already leaves only shared projects; the explicit check states the rule.
      if (project.visibility !== 'company') continue
      out.push({ ...project, owner: { id: userId, name: names.get(userId)! }, editable: false })
    }
  }
  return out.sort((a, b) => a.owner.name.localeCompare(b.owner.name) || a.label.localeCompare(b.label))
}

/** One project as the reader sees it (theirs, or a colleague's shared one), or null. */
export async function loadProjectForReader(
  readerId: string,
  ownerId: string,
  entityId: string,
): Promise<ProjectForReader | null> {
  const [project] = await listProjectsByEntityIds(ownerId, [entityId])
  if (!project) return null
  if (ownerId !== readerId && project.visibility !== 'company') return null
  const names = await ownerNamesOf([ownerId])
  return { ...project, owner: { id: ownerId, name: names.get(ownerId)! }, editable: ownerId === readerId }
}
