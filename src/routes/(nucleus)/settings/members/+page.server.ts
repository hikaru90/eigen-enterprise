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
  if (!roleCan(actor.role, 'members.manage')) error(403, 'Only the owner or an admin can manage members.')
  const deps = await memberDeps()
  const [list, groups] = await Promise.all([listMembers(actor, deps), listGroups(actor, await groupDeps())])
  return { ...list, groups, me: { id: user.id, role: actor.role }, companyName: deps.companyName }
}

async function act<T extends Record<string, unknown> | void>(
  event: Parameters<Actions[string]>[0],
  action: string,
  run: (form: FormData) => Promise<T>,
) {
  const user = event.locals.user
  if (!user) throw redirect(302, '/login')
  const form = await event.request.formData()
  try {
    const extra = await run(form)
    return { action, ok: true as const, ...(extra ?? {}) }
  } catch (err) {
    if (err instanceof MemberError) return fail(err.code === 'forbidden' ? 403 : 400, { action, error: err.message })
    const message = err instanceof Error ? err.message : String(err)
    return fail(500, { action, error: message })
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
      await setMemberRole(await humanActor(event.locals.user!.id), { userId: form.get('userId')?.toString() ?? '', role: role.data }, await memberDeps())
    }),
  remove: (event) =>
    act(event, 'remove', async (form) => {
      await removeMember(await humanActor(event.locals.user!.id), { userId: form.get('userId')?.toString() ?? '' }, await memberDeps())
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
      await deleteGroup(await humanActor(event.locals.user!.id), { groupId: form.get('groupId')?.toString() ?? '' }, await groupDeps())
    }),
}
