import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { GroupDeps } from '$lib/server/members/groups'
import type { OpenJoinDeps } from '$lib/server/members/open-join'
import type { Actor, MemberDeps } from '$lib/server/members/service'
import { KernelError } from '$lib/kernel/errors'
import { normalizeProfileNames } from '$lib/profile/profile'
import { MEMBERS_MODULE_ID } from './manifest'

/**
 * members.* kernel tools: the agent manages members from chat, behind the
 * company's approval mode (invite and set_role are approval-gated). A person
 * acts with their stored role; the agent acts with admin rights, so it can
 * never touch the owner either.
 */

/** A person's own profile writes: the same services /api/onboarding/name, /api/profile and /api/profile/avatar call. */
export type ProfileDeps = {
  /** "What should I call you?" (setWelcomeDisplayName). */
  setCalled(userId: string, name: string): Promise<void>
  /** Already validated by normalizeProfileNames (saveProfileNames). */
  saveNames(userId: string, names: { firstName: string; lastName: string; name: string }): Promise<void>
  /** Checks the picture as the route does (checkAvatar), then stores it; a refusal carries the route's sentence. */
  savePicture(userId: string, bytes: Uint8Array, mime: string): Promise<{ ok: true } | { ok: false; error: string }>
  profile(userId: string): Promise<unknown>
}

export type MembersToolDeps = {
  deps?: () => Promise<MemberDeps>
  actor?: (ctx: ToolContext) => Promise<Actor>
  groupDeps?: () => Promise<GroupDeps>
  profile?: () => Promise<ProfileDeps>
  openJoinDeps?: () => Promise<OpenJoinDeps>
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
const openJoinInput = z.object({ on: z.boolean() }).strict()
const removeInput = z.object({ user_id: z.string().min(1) }).strict()
const calledInput = z.object({ name: z.string().trim().min(1, 'Name must not be empty.').max(80, 'Name must be 80 characters or fewer.') }).strict()
const namesInput = z.object({ first_name: z.string(), last_name: z.string() }).strict()
/** The route's limit: at most 256 KB of picture bytes (MAX_AVATAR_BYTES), as base64. */
const pictureInput = z
  .object({ image_base64: z.string().min(1).max(Math.ceil((256 * 1024) / 3) * 4 + 4), mime: z.literal('image/webp') })
  .strict()

async function liveProfile(): Promise<ProfileDeps> {
  const [{ setWelcomeDisplayName }, profile, { checkAvatar }] = await Promise.all([
    import('$lib/server/onboarding/welcome'),
    import('$lib/server/profile/service'),
    import('$lib/server/profile/avatar'),
  ])
  return {
    setCalled: setWelcomeDisplayName,
    saveNames: profile.saveProfileNames,
    savePicture: async (userId, bytes, mime) => {
      const check = checkAvatar(bytes, mime)
      if (!check.ok) return { ok: false, error: check.error }
      await profile.saveAvatar(userId, bytes)
      return { ok: true }
    },
    profile: profile.getProfile,
  }
}

/** A person's own profile: the call must run as a person (themselves, or the brain acting as them). */
function selfOf(ctx: ToolContext): string {
  if (ctx.principal.kind !== 'human') {
    throw new KernelError('no_person', 'A profile belongs to a person; this call runs as no person.')
  }
  return ctx.principal.id
}

async function liveGroupDeps(): Promise<GroupDeps> {
  const { groupDeps } = await import('$lib/server/members')
  return groupDeps()
}

async function liveOpenJoinDeps(): Promise<OpenJoinDeps> {
  const { openJoinDeps } = await import('$lib/server/members')
  return openJoinDeps()
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
  const profile = opts.profile ?? liveProfile
  const openJoinDeps = opts.openJoinDeps ?? liveOpenJoinDeps
  const openJoin = () => import('$lib/server/members/open-join')
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
      // Every member sees the company's groups (the service asks only membership).
      permission: { roles: ['admin', 'member', 'agent'] },
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
    {
      name: 'members.remove',
      module: MEMBERS_MODULE_ID,
      summary: 'Remove a member from the company (Settings → Members): they lose their account’s access. The owner can’t be removed.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      activity: (_input: z.infer<typeof removeInput>, output: unknown) =>
        `Removed ${(output as { email?: string } | undefined)?.email ?? 'a member'} from the company`,
      inputSchema: removeInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = removeInput.parse(input)
        return (await service()).removeMember(await actor(ctx), { userId: i.user_id }, await deps())
      },
    },
    {
      name: 'members.get_open_join',
      module: MEMBERS_MODULE_ID,
      summary:
        'Whether the company is open to join (Settings → Members): when on, anyone who verifies their email with a sign-in code on /signup joins as a member. Off by default.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx) => (await openJoin()).readOpenJoin(await actor(ctx), await openJoinDeps()),
    },
    {
      name: 'members.set_open_join',
      module: MEMBERS_MODULE_ID,
      summary:
        'Switch open join (Settings → Members): on = anyone who verifies their email on /signup joins the company as a member; off = people join by invite only.',
      auditClass: 'mutate',
      // Open join lets anyone on the internet into the company: public.
      approvalRisk: 'public',
      activity: (input: z.infer<typeof openJoinInput>) =>
        input.on
          ? 'Opened the company to anyone who verifies their email (open join)'
          : 'Closed open join: people join by invite only',
      inputSchema: openJoinInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = openJoinInput.parse(input)
        return (await openJoin()).setOpenJoin(await actor(ctx), { on: i.on }, await openJoinDeps())
      },
    },
    {
      name: 'members.set_my_called',
      module: MEMBERS_MODULE_ID,
      summary: 'Set what the company calls you (the welcome’s “What should I call you?”): your display name, also your account name.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof calledInput>) => `Asked to be called ${input.name.trim()}`,
      inputSchema: calledInput,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx, input) => {
        const i = calledInput.parse(input)
        const userId = selfOf(ctx)
        await (await profile()).setCalled(userId, i.name)
        return { ok: true, name: i.name }
      },
    },
    {
      name: 'members.set_my_name',
      module: MEMBERS_MODULE_ID,
      summary: 'Set your own first and last name (both required); your account name becomes “First Last”.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof namesInput>) => `Set my name to ${input.first_name} ${input.last_name}`.trim(),
      inputSchema: namesInput,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx, input) => {
        const i = namesInput.parse(input)
        const userId = selfOf(ctx)
        const names = normalizeProfileNames({ firstName: i.first_name, lastName: i.last_name })
        if (!names.ok) throw new KernelError('invalid_input', names.error)
        const p = await profile()
        await p.saveNames(userId, names)
        return { profile: await p.profile(userId) }
      },
    },
    {
      name: 'members.set_my_picture',
      module: MEMBERS_MODULE_ID,
      summary:
        'Set your own profile picture: an already cropped square WebP (64–512 px, at most 256 KB) as base64 — the same picture the profile page uploads after cropping.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: () => 'Changed my profile picture',
      inputSchema: pictureInput,
      permission: { roles: ['admin', 'member'] },
      handler: async (ctx, input) => {
        const i = pictureInput.parse(input)
        const userId = selfOf(ctx)
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(i.image_base64)) throw new KernelError('invalid_input', 'image_base64 is not base64.')
        const p = await profile()
        const saved = await p.savePicture(userId, new Uint8Array(Buffer.from(i.image_base64, 'base64')), i.mime)
        if (!saved.ok) throw new KernelError('invalid_input', saved.error)
        return { profile: await p.profile(userId) }
      },
    },
  ]
}
