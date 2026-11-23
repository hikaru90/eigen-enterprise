import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { managerName } from '$lib/coworkers/org-tree'
import type { CoworkerView } from '$lib/server/coworkers/service'
import { loadOrgPeople } from '$lib/server/org/org-people'
import { personRun, type PersonRunner } from '$lib/server/org/person-run'

/**
 * A seat's profile (plan/phase-ai-coworkers.md C5), reachable from the org
 * chart, the Messages people directory and Settings → Co-workers: the role
 * card — title, accountabilities, reports-to — and for an AI co-worker its
 * lens, model, daily cap, whether it is on and the person it answers to.
 * "Message" opens the DM through the existing messages.open_dm route. Reads
 * only (org.chart, coworkers.list, coworkers.get), for every member.
 */

/** Overridable in tests. */
export const _profileDeps: { run: PersonRunner; role: (userId: string) => Promise<string | null> } = {
  run: personRun,
  role: async (userId) => (await import('$lib/server/auth/user-role')).getUserRole(userId),
}

export type CoworkerCard = Pick<
  CoworkerView,
  'lens' | 'modelId' | 'enabled' | 'dailyCapUsd' | 'accountableHuman'
>

export const load: PageServerLoad = async ({ locals, params }) => {
  const user = locals.user
  if (!user) throw redirect(302, '/login')
  const [people, role] = await Promise.all([loadOrgPeople(_profileDeps.run, user), _profileDeps.role(user.id)])
  const person = people.find((p) => p.id === params.id)
  if (!person) error(404, 'No one with this seat is in the org chart.')
  let coworker: CoworkerCard | null = null
  if (person.kind === 'coworker') {
    const c = await _profileDeps.run<CoworkerView>(user, 'coworkers.get', { user_id: person.id })
    coworker = {
      lens: c.lens,
      modelId: c.modelId,
      enabled: c.enabled,
      dailyCapUsd: c.dailyCapUsd,
      accountableHuman: c.accountableHuman,
    }
  }
  return {
    person,
    manager: person.reportsToUserId ? { id: person.reportsToUserId, name: managerName(people, person) } : null,
    reports: people.filter((p) => p.reportsToUserId === person.id).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    coworker,
    me: { id: user.id, canManage: role === 'owner' || role === 'admin' },
  }
}
