import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import {
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
 * invite people by email with a role, change roles and remove members. The
 * owner can't be demoted or removed (service rules). The person clicking is
 * the decision, so this page calls the members service directly; the agent
 * goes through the approval-gated members.* tools.
 */

export const load: PageServerLoad = async (event) => {
  const user = event.locals.user
  if (!user) throw redirect(302, '/login')
  const actor = await humanActor(user.id)
  if (actor.role !== 'owner' && actor.role !== 'admin') error(403, 'Only the owner or an admin can manage members.')
  const deps = await memberDeps()
  return { ...(await listMembers(actor, deps)), me: { id: user.id, role: actor.role }, companyName: deps.companyName }
}

async function act(event: Parameters<Actions[string]>[0], action: string, run: (form: FormData) => Promise<unknown>) {
  const user = event.locals.user
  if (!user) throw redirect(302, '/login')
  const form = await event.request.formData()
  try {
    await run(form)
    return { action, ok: true as const }
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
      await inviteMember(await humanActor(event.locals.user!.id), { email: form.get('email')?.toString() ?? '', role: role.data }, await memberDeps())
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
}
