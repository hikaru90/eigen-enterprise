import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
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
}

const listInput = z.object({}).strict()
const inviteInput = z.object({ email: z.email(), role: z.enum(['admin', 'member']) }).strict()
const setRoleInput = z.object({ user_id: z.string().min(1), role: z.enum(['admin', 'member']) }).strict()

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
  const service = () => import('$lib/server/members/service')
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
        return (await service()).inviteMember(await actor(ctx), i, await deps())
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
  ]
}
