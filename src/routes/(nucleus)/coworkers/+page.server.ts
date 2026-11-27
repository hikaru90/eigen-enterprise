import type { Actions, PageServerLoad } from './$types'
import type { ChatModelOption } from '$lib/coworkers/model-family'
import type { RhythmTarget, RhythmView } from '$lib/server/coworkers/rhythms'
import type { CoworkerView } from '$lib/server/coworkers/service'
import type { CoworkerTemplate } from '$lib/server/coworkers/templates'
import type { PersonRunner } from '$lib/server/org/person-run'
import { redirect } from '@sveltejs/kit'
import { chatModelOption } from '$lib/coworkers/model-family'
import { requireCapability } from '$lib/server/auth/require-capability'
import { chatModels } from '$lib/server/llm/model-pool'
import { cardInput, seatInput } from '$lib/server/org/form-input'
import { loadOrgPeople } from '$lib/server/org/org-people'
import { field, runAction } from '$lib/server/org/page-actions'
import { personRun } from '$lib/server/org/person-run'

const REASON = 'Only the owner or an admin manages the AI co-workers.'

/** Overridable in tests. */
export const _coworkersPageDeps: {
  run: PersonRunner
  role: (userId: string) => Promise<string | null>
  chatModels: () => ChatModelOption[]
  timeZone: (userId: string) => Promise<string>
} = {
  run: personRun,
  role: async (userId) => (await import('$lib/server/auth/user-role')).getUserRole(userId),
  chatModels: () => chatModels().map(chatModelOption),
  timeZone: async (userId) => {
    const [{ withDbUser }, { getUserPreferredTimezone }] = await Promise.all([
      import('$lib/server/db'),
      import('$lib/server/memory/user-timezone'),
    ])
    return withDbUser(userId, () => getUserPreferredTimezone(userId))
  },
}

export type CoworkerRhythms = { rhythms: RhythmView[]; targets: RhythmTarget[] }
export type SeatOption = { id: string; name: string; kind: 'human' | 'coworker' }

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user
  if (!user) throw redirect(302, '/login')

  const run = _coworkersPageDeps.run
  let coworkersPromise: Promise<{ coworkers: CoworkerView[] }> | null = null
  const loadRun: PersonRunner = <T>(
    u: { id: string },
    tool: string,
    input: unknown,
  ): Promise<T> => {
    if (tool === 'coworkers.list') {
      if (coworkersPromise === null) {
        coworkersPromise = run<{ coworkers: CoworkerView[] }>(u, tool, input)
      }
      return coworkersPromise as Promise<T>
    }
    return run<T>(u, tool, input)
  }

  const [people, role] = await Promise.all([
    loadOrgPeople(loadRun, user),
    _coworkersPageDeps.role(user.id),
  ])
  const canManage = role === 'owner' || role === 'admin'
  if (!canManage) {
    return {
      people,
      me: { id: user.id, canManage: false },
      coworkers: [] as CoworkerView[],
      rhythms: {} as Record<string, CoworkerRhythms>,
      timeZone: null as string | null,
      templates: [] as CoworkerTemplate[],
      models: [] as ChatModelOption[],
      seats: [] as SeatOption[],
    }
  }

  const [list, templates, timeZone] = await Promise.all([
    loadRun<{ coworkers: CoworkerView[] }>(user, 'coworkers.list', {}),
    run<{ templates: CoworkerTemplate[] }>(user, 'coworkers.templates', {}),
    _coworkersPageDeps.timeZone(user.id),
  ])
  const coworkers = list.coworkers.filter((c) => c.removedAt === null)
  const rhythms: Record<string, CoworkerRhythms> = {}
  for (const c of coworkers) {
    rhythms[c.id] = await run<CoworkerRhythms>(user, 'coworkers.rhythm_list', { user_id: c.id })
  }

  return {
    people,
    me: { id: user.id, canManage: true },
    coworkers,
    rhythms,
    timeZone,
    templates: templates.templates,
    models: _coworkersPageDeps.chatModels(),
    seats: people.map((p): SeatOption => ({ id: p.id, name: p.name, kind: p.kind })),
  }
}

type ManageAction =
  | 'create'
  | 'update'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'rhythmCreate'
  | 'rhythmUpdate'
  | 'rhythmDelete'
  | 'rhythmRunNow'

const ATTEMPTED: Record<ManageAction, string> = {
  create: 'Creating an AI co-worker (AI Co-workers)',
  update: 'Changing an AI co-worker (AI Co-workers)',
  enable: 'Switching an AI co-worker on (AI Co-workers)',
  disable: 'Switching an AI co-worker off (AI Co-workers)',
  remove: 'Removing an AI co-worker (AI Co-workers)',
  rhythmCreate: 'Adding a rhythm to an AI co-worker (AI Co-workers)',
  rhythmUpdate: 'Changing an AI co-worker’s rhythm (AI Co-workers)',
  rhythmDelete: 'Deleting an AI co-worker’s rhythm (AI Co-workers)',
  rhythmRunNow: 'Running an AI co-worker’s rhythm now (AI Co-workers)',
}

const TOOL: Record<ManageAction, string> = {
  create: 'coworkers.create',
  update: 'coworkers.update',
  enable: 'coworkers.enable',
  disable: 'coworkers.disable',
  remove: 'coworkers.remove',
  rhythmCreate: 'coworkers.rhythm_create',
  rhythmUpdate: 'coworkers.rhythm_update',
  rhythmDelete: 'coworkers.rhythm_delete',
  rhythmRunNow: 'coworkers.rhythm_run_now',
}

function rhythmInput(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (form.has('weekdays_sent')) out.weekdays = form.getAll('weekdays').map(String)
  for (const [key, name] of [
    ['time', 'time'],
    ['time_zone', 'time_zone'],
    ['instruction', 'instruction'],
    ['conversation_id', 'conversation_id'],
  ] as const) {
    if (form.has(key)) out[name] = field(form, key).trim()
  }
  if (form.has('enabled')) out.enabled = field(form, 'enabled') === 'true'
  return out
}

function inputFor(action: ManageAction, form: FormData): Record<string, unknown> {
  switch (action) {
    case 'create': {
      const template = field(form, 'template_id')
      return { ...(template ? { template_id: template } : {}), ...cardInput(form, 'create') }
    }
    case 'update':
      return { user_id: field(form, 'user_id'), ...cardInput(form, 'update') }
    case 'enable':
    case 'disable':
    case 'remove':
      return { user_id: field(form, 'user_id') }
    case 'rhythmCreate':
      return { user_id: field(form, 'user_id'), ...rhythmInput(form) }
    case 'rhythmUpdate':
      return { rhythm_id: field(form, 'rhythm_id'), ...rhythmInput(form) }
    case 'rhythmDelete':
    case 'rhythmRunNow':
      return { rhythm_id: field(form, 'rhythm_id') }
  }
}

function manage(action: ManageAction) {
  return async (event: Parameters<Actions[string]>[0]) => {
    const { user } = await requireCapability(event.locals, 'coworkers.manage', REASON)
    const form = await event.request.formData()
    const input = inputFor(action, form)
    const userId = action === 'create' ? undefined : field(form, 'user_id')
    return runAction(
      action,
      { attempted: ATTEMPTED[action], tool: TOOL[action], input, userId, log: 'coworkers' },
      () => _coworkersPageDeps.run(user, TOOL[action], input),
    )
  }
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
      {
        attempted: 'Changing a seat in the org chart (AI Co-workers)',
        tool: 'org.set_position',
        input,
        userId,
        log: 'coworkers',
      },
      () => _coworkersPageDeps.run(user, 'org.set_position', input),
    )
  },
  create: manage('create'),
  update: manage('update'),
  enable: manage('enable'),
  disable: manage('disable'),
  remove: manage('remove'),
  rhythmCreate: manage('rhythmCreate'),
  rhythmUpdate: manage('rhythmUpdate'),
  rhythmDelete: manage('rhythmDelete'),
  rhythmRunNow: manage('rhythmRunNow'),
}
