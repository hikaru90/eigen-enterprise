import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { GroupDeps } from '$lib/server/members/groups'
import type { Actor, MemberDeps } from '$lib/server/members/service'
import { MEMBERS_MODULE_ID } from './manifest'

/**
 * members.* kernel tools: the agent manages members from chat, behind the
 * company's approval mode (invite and set_role are approval-gated). A person
 * acts with their stored role; the agent acts with admin rights, so it can
 * never touch the owner either.
 */

export type MembersToolDeps = {
  deps?: () => Promise<MemberDeps>
  actor?: (ctx: ToolContext) => Promise<Actor>
  groupDeps?: () => Promise<GroupDeps>
}

const listInput = z.object({}).strict()
const inviteInput = z.object({ email: z.email(), role: z.enum(['admin', 'member']) }).strict()
const setRoleInput = z.object({ user_id: z.string().min(1), role: z.enum(['admin', 'member']) }).strict()
const groupCreateInput = z
  .object({ name: z.string().min(1).max(80), description: z.string().max(500).optional(), member_ids: z.array(z.string().min(1)).optional() })
  .strict()
const groupUpdateInput = z
  .object({
    group_id: z.string().min(1),
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    member_ids: z.array(z.string().min(1)).optional(),
  })
  .strict()
const groupDeleteInput = z.object({ group_id: z.string().min(1) }).strict()

async function liveGroupDeps(): Promise<GroupDeps> {
  const { groupDeps } = await import('$lib/server/members')
  return groupDeps()
}

async function liveDeps(): Promise<MemberDeps> {
  const { memberDeps } = await import('$lib/server/members')
  return memberDeps()
}

async function liveActor(ctx: ToolContext): Promise<Actor> {
  if (ctx.principal.kind !== 'human') return { id: ctx.principal.id, role: 'admin' }
  const { humanActor } = await import('$lib/server/members')
  return humanActor(ctx.principal.id)
}

export function createMembersTools(opts: MembersToolDeps = {}): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const actor = opts.actor ?? liveActor
  const groupDeps = opts.groupDeps ?? liveGroupDeps
  const service = () => import('$lib/server/members/service')
  const groups = () => import('$lib/server/members/groups')
  return [
    {
      name: 'members.list',
      module: MEMBERS_MODULE_ID,
      summary: "List the company's members with their roles, and the invites not yet accepted.",
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => (await service()).listMembers(await actor(ctx), await deps()),
    },
    {
      name: 'members.invite',
      module: MEMBERS_MODULE_ID,
      summary:
        'Invite a person by email as admin or member. Sends a one-time link through the company mail; accepting it creates their account with that role.',
      auditClass: 'external',
      approvalRisk: 'external',
      activity: (input: z.infer<typeof inviteInput>) => `Invited ${input.email} as ${input.role === 'admin' ? 'an admin' : 'a member'}`,
      inputSchema: inviteInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = inviteInput.parse(input)
        // The link is a credential: it goes to the invited address (company mail) or to
        // the person copying it in Settings → Members — never into the agent's transcript.
        const { url: _url, ...out } = await (await service()).inviteMember(await actor(ctx), i, await deps())
        void _url
        return out.emailed
          ? out
          : { ...out, note: 'Company mail is not set up, so nothing was sent. The owner can copy a fresh invite link in Settings → Members.' }
      },
    },
    {
      name: 'members.set_role',
      module: MEMBERS_MODULE_ID,
      summary: "Change a member's role to admin or member. The owner's role can't be changed.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof setRoleInput>, output: unknown) => {
        const email = (output as { email?: string } | undefined)?.email
        return `Changed ${email ?? 'a member'}'s role to ${input.role}`
      },
      inputSchema: setRoleInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = setRoleInput.parse(input)
        return (await service()).setMemberRole(await actor(ctx), { userId: i.user_id, role: i.role }, await deps())
      },
    },
    {
      name: 'members.group_list',
      module: MEMBERS_MODULE_ID,
      summary: "List the company's groups (departments such as Sales or Dev) with their member ids.",
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => (await groups()).listGroups(await actor(ctx), await groupDeps()),
    },
    {
      name: 'members.group_create',
      module: MEMBERS_MODULE_ID,
      summary: 'Create a group (e.g. Sales) with an optional description and member ids (from members.list).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof groupCreateInput>) => `Created the group ${input.name}`,
      inputSchema: groupCreateInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = groupCreateInput.parse(input)
        return (await groups()).createGroup(
          await actor(ctx),
          { name: i.name, description: i.description, memberIds: i.member_ids },
          await groupDeps(),
        )
      },
    },
    {
      name: 'members.group_update',
      module: MEMBERS_MODULE_ID,
      summary: "Rename a group, change its description, or replace its members (member_ids is the full new list).",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: z.infer<typeof groupUpdateInput>, output: unknown) =>
        `Updated the group ${(output as { name?: string } | undefined)?.name ?? ''}`.trim(),
      inputSchema: groupUpdateInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = groupUpdateInput.parse(input)
        return (await groups()).updateGroup(
          await actor(ctx),
          { groupId: i.group_id, name: i.name, description: i.description, memberIds: i.member_ids },
          await groupDeps(),
        )
      },
    },
    {
      name: 'members.group_delete',
      module: MEMBERS_MODULE_ID,
      summary: 'Delete a group. Everything shared with the group stops being shared with its members.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (_input: z.infer<typeof groupDeleteInput>, output: unknown) =>
        `Deleted the group ${(output as { name?: string } | undefined)?.name ?? ''}`.trim(),
      inputSchema: groupDeleteInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = groupDeleteInput.parse(input)
        return (await groups()).deleteGroup(await actor(ctx), { groupId: i.group_id }, await groupDeps())
      },
    },
  ]
}
