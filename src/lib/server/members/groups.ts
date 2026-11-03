import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MemberError, type Actor } from './service'

/**
 * Groups (departments such as Sales or Dev): a name, a description and
 * members. Everyone in the company can see the groups (they are who a folder
 * or channel is shared with); only the owner and admins create, change or
 * delete them. Access to resources is granted to groups through
 * $lib/server/access. Every change is audited as a kernel event.
 */
export type Group = { id: string; name: string; description: string; memberIds: string[]; createdAt: Date }

export type GroupStore = {
  listGroups(): Promise<Group[]>
  getGroup(id: string): Promise<Group | null>
  findGroupByName(name: string): Promise<Group | null>
  insertGroup(group: { id: string; name: string; description: string; createdBy: string; memberIds: string[] }): Promise<void>
  updateGroup(id: string, patch: { name: string; description: string }): Promise<void>
  /** Replace the full member list. */
  setGroupMembers(id: string, memberIds: string[]): Promise<void>
  deleteGroup(id: string): Promise<void>
  /** Which of these user ids are company members. */
  existingMemberIds(ids: string[]): Promise<Set<string>>
}

export type GroupAudit = (event: { type: string; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type GroupDeps = { groups: GroupStore; audit: GroupAudit }

export type GroupView = { id: string; name: string; description: string; memberIds: string[] }

const nameSchema = z.string().trim().min(1, 'Give the group a name.').max(80, 'Keep the name under 80 characters.')
const descriptionSchema = z.string().trim().max(500, 'Keep the description under 500 characters.')

function assertCanManage(actor: Actor): void {
  if (actor.role !== 'owner' && actor.role !== 'admin') {
    throw new MemberError('forbidden', 'Only the owner or an admin can manage groups.')
  }
}

function assertMember(actor: Actor): void {
  if (!actor.role) throw new MemberError('forbidden', 'Only company members can see groups.')
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new MemberError('invalid_group', r.error.issues[0]?.message ?? 'Invalid group.')
  return r.data
}

const view = (g: Group): GroupView => ({ id: g.id, name: g.name, description: g.description, memberIds: [...g.memberIds] })

async function checkMembers(ids: string[], deps: GroupDeps): Promise<string[]> {
  const unique = [...new Set(ids)]
  const known = await deps.groups.existingMemberIds(unique)
  const missing = unique.filter((id) => !known.has(id))
  if (missing.length) throw new MemberError('not_found', `No such member: ${missing.join(', ')}`)
  return unique
}

async function uniqueName(name: string, exceptId: string | null, deps: GroupDeps): Promise<void> {
  const clash = await deps.groups.findGroupByName(name)
  if (clash && clash.id !== exceptId) throw new MemberError('invalid_group', `A group called ${clash.name} already exists.`)
}

export async function listGroups(actor: Actor, deps: GroupDeps): Promise<GroupView[]> {
  assertMember(actor)
  return (await deps.groups.listGroups()).map(view)
}

export async function createGroup(
  actor: Actor,
  input: { name: string; description?: string; memberIds?: string[] },
  deps: GroupDeps,
): Promise<GroupView> {
  assertCanManage(actor)
  const name = parse(nameSchema, input.name)
  const description = parse(descriptionSchema, input.description ?? '')
  await uniqueName(name, null, deps)
  const memberIds = await checkMembers(input.memberIds ?? [], deps)
  const id = randomUUID()
  await deps.groups.insertGroup({ id, name, description, createdBy: actor.id, memberIds })
  await deps.audit({ type: 'members.group_created', principalId: actor.id, payload: { groupId: id, name, memberIds } })
  return { id, name, description, memberIds }
}

export async function updateGroup(
  actor: Actor,
  input: { groupId: string; name?: string; description?: string; memberIds?: string[] },
  deps: GroupDeps,
): Promise<GroupView> {
  assertCanManage(actor)
  const group = await deps.groups.getGroup(input.groupId)
  if (!group) throw new MemberError('not_found', 'No such group.')
  const name = input.name === undefined ? group.name : parse(nameSchema, input.name)
  const description = input.description === undefined ? group.description : parse(descriptionSchema, input.description)
  if (name !== group.name) await uniqueName(name, group.id, deps)
  const memberIds = input.memberIds === undefined ? group.memberIds : await checkMembers(input.memberIds, deps)
  if (name !== group.name || description !== group.description) await deps.groups.updateGroup(group.id, { name, description })
  if (input.memberIds !== undefined) await deps.groups.setGroupMembers(group.id, memberIds)
  await deps.audit({
    type: 'members.group_updated',
    principalId: actor.id,
    payload: {
      groupId: group.id,
      name,
      ...(name !== group.name ? { renamedFrom: group.name } : {}),
      ...(input.memberIds !== undefined
        ? {
            added: memberIds.filter((id) => !group.memberIds.includes(id)),
            removed: group.memberIds.filter((id) => !memberIds.includes(id)),
          }
        : {}),
    },
  })
  return { id: group.id, name, description, memberIds }
}

export async function deleteGroup(actor: Actor, input: { groupId: string }, deps: GroupDeps): Promise<{ groupId: string; name: string }> {
  assertCanManage(actor)
  const group = await deps.groups.getGroup(input.groupId)
  if (!group) throw new MemberError('not_found', 'No such group.')
  await deps.groups.deleteGroup(group.id)
  await deps.audit({ type: 'members.group_deleted', principalId: actor.id, payload: { groupId: group.id, name: group.name } })
  return { groupId: group.id, name: group.name }
}

/** In-memory GroupStore (tests). */
export function memoryGroupStore(memberIds: string[] = []): GroupStore & { groups: Group[]; members: Set<string> } {
  const s = {
    groups: [] as Group[],
    members: new Set(memberIds),
    async listGroups() {
      return [...s.groups].sort((a, b) => a.name.localeCompare(b.name))
    },
    async getGroup(id: string) {
      return s.groups.find((g) => g.id === id) ?? null
    },
    async findGroupByName(name: string) {
      return s.groups.find((g) => g.name.toLowerCase() === name.toLowerCase()) ?? null
    },
    async insertGroup(g: { id: string; name: string; description: string; memberIds: string[] }) {
      s.groups.push({ ...g, createdAt: new Date() })
    },
    async updateGroup(id: string, patch: { name: string; description: string }) {
      s.groups = s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g))
    },
    async setGroupMembers(id: string, ids: string[]) {
      s.groups = s.groups.map((g) => (g.id === id ? { ...g, memberIds: [...ids] } : g))
    },
    async deleteGroup(id: string) {
      s.groups = s.groups.filter((g) => g.id !== id)
    },
    async existingMemberIds(ids: string[]) {
      return new Set(ids.filter((id) => s.members.has(id)))
    },
  }
  return s
}
