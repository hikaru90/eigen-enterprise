import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { seatInput } from '$lib/server/org/form-input'
import { loadOrgPeople } from '$lib/server/org/org-people'
import { field, runAction } from '$lib/server/org/page-actions'
import { personRun, type PersonRunner } from '$lib/server/org/person-run'

/**
 * Settings → Org chart (plan/phase-ai-coworkers.md C5): every member sees who
 * reports to whom — people and AI co-workers alike — with titles and
 * accountabilities. The owner and admins edit anyone's seat (title,
 * accountabilities, reports-to); a member edits their own title and
 * accountabilities. A client of org.chart / coworkers.list / org.set_position
 * (personRun): a member's change may wait for an owner's or admin's approval
 * when the approval mode gates it.
 */

/** Overridable in tests. */
export const _orgDeps: { run: PersonRunner; role: (userId: string) => Promise<string | null> } = {
  run: personRun,
  role: async (userId) => (await import('$lib/server/auth/user-role')).getUserRole(userId),
}

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user
  if (!user) throw redirect(302, '/login')
  const [people, role] = await Promise.all([loadOrgPeople(_orgDeps.run, user), _orgDeps.role(user.id)])
  return { people, me: { id: user.id, canManage: role === 'owner' || role === 'admin' } }
}

export const actions: Actions = {
  setPosition: async ({ locals, request }) => {
    const user = locals.user
    if (!user) throw redirect(302, '/login')
    const form = await request.formData()
    const userId = field(form, 'user_id')
    const input = seatInput(form)
    return runAction(
      'setPosition',
      { attempted: 'Changing a seat in the org chart (Settings → Org chart)', tool: 'org.set_position', input, userId, log: 'settings/org' },
      () => _orgDeps.run(user, 'org.set_position', input),
    )
  },
}
