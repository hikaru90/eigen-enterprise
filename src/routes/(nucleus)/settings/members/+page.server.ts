import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { roleCan } from '$lib/server/auth/capabilities'
import {
  createGroup,
  deleteGroup,
  groupDeps,
  listGroups,
  updateGroup,
  humanActor,
  inviteMember,
  listMembers,
  MemberError,
  memberDeps,
  removeMember,
  setMemberRole,
  invitableRole,
} from '$lib/server/members'
import { errorReport } from '$lib/server/errors/report'

/**
 * Settings → Members: the owner and admins see who belongs to the company,
 * invite people with a role (a one-time link to copy; also emailed when
 * company mail is set up), change roles, remove members (their sessions end:
 * deleting the user cascades to its sessions), and manage groups. The
 * owner can't be demoted or removed (service rules). The person clicking is
 * the decision, so this page calls the members service directly; the agent
 * goes through the approval-gated members.* tools.
 */

export const load: PageServerLoad = async (event) => {
  const user = event.locals.user
  if (!user) throw redirect(302, '/login')
  const actor = await humanActor(user.id)
  if (!roleCan(actor.role, 'members.manage'))
    error(403, 'Only the owner or an admin can manage members.')
  const deps = await memberDeps()
  const [list, groups] = await Promise.all([
    listMembers(actor, deps),
    listGroups(actor, await groupDeps()),
  ])
  return { ...list, groups, me: { id: user.id, role: actor.role }, companyName: deps.companyName }
}

type MembersAction = 'invite' | 'setRole' | 'remove' | 'createGroup' | 'updateGroup' | 'deleteGroup'

const ATTEMPTED: Record<MembersAction, string> = {
  invite: 'Inviting someone (Settings → Members)',
  setRole: "Changing a member's role (Settings → Members)",
  remove: 'Removing a member (Settings → Members)',
  createGroup: 'Creating a group (Settings → Members)',
  updateGroup: 'Changing a group (Settings → Members)',
  deleteGroup: 'Deleting a group (Settings → Members)',
}

/** What the agent may see of the form: ids, role and group fields — never the invitee's address. */
function agentInput(action: MembersAction, form: FormData): Record<string, unknown> {
  const str = (k: string) => form.get(k)?.toString() ?? ''
  switch (action) {
    case 'invite':
      return { role: str('role') }
    case 'setRole':
      return { userId: str('userId'), role: str('role') }
    case 'remove':
      return { userId: str('userId') }
    case 'deleteGroup':
      return { groupId: str('groupId') }
    case 'createGroup':
    case 'updateGroup':
      return {
        ...(action === 'updateGroup' ? { groupId: str('groupId') } : {}),
        name: str('name'),
        memberIds: form.getAll('memberIds').map(String),
      }
  }
}

async function act<T extends Record<string, unknown> | void>(
  event: Parameters<Actions[string]>[0],
  action: MembersAction,
  run: (form: FormData) => Promise<T>,
) {
  const user = event.locals.user
  if (!user) throw redirect(302, '/login')
  const form = await event.request.formData()
  try {
    const extra = await run(form)
    return { action, ok: true as const, ...(extra ?? {}) }
  } catch (err) {
    const member = err instanceof MemberError
    if (!member) console.error(`[settings/members] ${action} failed`, err)
    const report = errorReport(err, {
      attempted: ATTEMPTED[action],
      input: agentInput(action, form),
      plain: (e) => (e instanceof Error ? e.message : String(e)),
      nextSteps: [
        member
          ? `The members service (src/lib/server/members) refused this with MemberError code "${err.code}"; the sentence says why. The service rules (the owner cannot be demoted or removed, roles) are intended.`
          : 'The members service failed unexpectedly (src/lib/server/members). The server journal has the stack.',
      ],
    })
    if (member) return fail(err.code === 'forbidden' ? 403 : 400, { action, ...report })
    return fail(500, { action, ...report })
  }
}

export const actions: Actions = {
  invite: (event) =>
    act(event, 'invite', async (form) => {
      const role = invitableRole.safeParse(form.get('role')?.toString())
      if (!role.success) throw new MemberError('invalid_role', 'Pick a role: admin or member.')
      const out = await inviteMember(
        await humanActor(event.locals.user!.id),
        { email: form.get('email')?.toString() ?? '', role: role.data },
        await memberDeps(),
      )
      // The link goes back to the inviter once, to copy into a message (W-4).
      return { inviteUrl: out.url, inviteEmail: out.email, emailed: out.emailed }
    }),
  setRole: (event) =>
    act(event, 'setRole', async (form) => {
      const role = invitableRole.safeParse(form.get('role')?.toString())
      if (!role.success) throw new MemberError('invalid_role', 'Pick a role: admin or member.')
      await setMemberRole(
        await humanActor(event.locals.user!.id),
        { userId: form.get('userId')?.toString() ?? '', role: role.data },
        await memberDeps(),
      )
    }),
  remove: (event) =>
    act(event, 'remove', async (form) => {
      await removeMember(
        await humanActor(event.locals.user!.id),
        { userId: form.get('userId')?.toString() ?? '' },
        await memberDeps(),
      )
    }),
  createGroup: (event) =>
    act(event, 'createGroup', async (form) => {
      await createGroup(
        await humanActor(event.locals.user!.id),
        {
          name: form.get('name')?.toString() ?? '',
          description: form.get('description')?.toString() ?? '',
          memberIds: form.getAll('memberIds').map(String),
        },
        await groupDeps(),
      )
    }),
  updateGroup: (event) =>
    act(event, 'updateGroup', async (form) => {
      await updateGroup(
        await humanActor(event.locals.user!.id),
        {
          groupId: form.get('groupId')?.toString() ?? '',
          name: form.get('name')?.toString() ?? '',
          description: form.get('description')?.toString() ?? '',
          memberIds: form.getAll('memberIds').map(String),
        },
        await groupDeps(),
      )
    }),
  deleteGroup: (event) =>
    act(event, 'deleteGroup', async (form) => {
      await deleteGroup(
        await humanActor(event.locals.user!.id),
        { groupId: form.get('groupId')?.toString() ?? '' },
        await groupDeps(),
      )
    }),
}
