import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { managerName } from '$lib/coworkers/org-tree'
import type { RunItem } from '$lib/coworkers/run-format'
import type { CoworkerView } from '$lib/server/coworkers/service'
import { loadOrgPeople } from '$lib/server/org/org-people'
import { field, runAction } from '$lib/server/org/page-actions'
import { personRun, type PersonRunner } from '$lib/server/org/person-run'

/**
 * A seat's profile (plan/phase-ai-coworkers.md C5), reachable from the org
 * chart, the Messages people directory and Settings → Co-workers: the role
 * card — title, accountabilities, reports-to — and for an AI co-worker its
 * lens, model, daily cap, whether it is on and the person it answers to.
 * "Message" opens the DM through the existing messages.open_dm route. Reads
 * (org.chart, coworkers.list, coworkers.get), for every member.
 *
 * C6: an AI co-worker's run log (coworkers.runs), and the "Got it" of a
 * co-worker's row in Needs you (?/noticeSeen → coworkers.notice_seen), posted
 * from the dashboard.
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
  let runs: RunItem[] = []
  if (person.kind === 'coworker') {
    const c = await _profileDeps.run<CoworkerView>(user, 'coworkers.get', { user_id: person.id })
    coworker = {
      lens: c.lens,
      modelId: c.modelId,
      enabled: c.enabled,
      dailyCapUsd: c.dailyCapUsd,
      accountableHuman: c.accountableHuman,
    }
    runs = (await _profileDeps.run<{ runs: RunItem[] }>(user, 'coworkers.runs', { user_id: person.id, limit: 30 })).runs
  }
  return {
    person,
    manager: person.reportsToUserId ? { id: person.reportsToUserId, name: managerName(people, person) } : null,
    reports: people.filter((p) => p.reportsToUserId === person.id).map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    coworker,
    runs,
    me: { id: user.id, canManage: role === 'owner' || role === 'admin' },
  }
}

export const actions: Actions = {
  /** "Got it" on a co-worker's row in Needs you: coworkers.notice_seen as the person. */
  noticeSeen: async ({ locals, request }) => {
    const user = locals.user
    if (!user) throw redirect(302, '/login')
    const runId = field(await request.formData(), 'run_id')
    const input = { run_id: runId }
    return runAction(
      'noticeSeen',
      { attempted: "Acknowledging an AI co-worker's result (Needs you)", tool: 'coworkers.notice_seen', input, log: 'settings/org/[id]' },
      () => _profileDeps.run(user, 'coworkers.notice_seen', input),
    )
  },
}
