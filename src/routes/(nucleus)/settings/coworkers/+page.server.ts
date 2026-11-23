import type { Actions, PageServerLoad } from './$types'
import { chatModelOption, type ChatModelOption } from '$lib/coworkers/model-family'
import { accountabilityLines } from '$lib/coworkers/org-tree'
import { requireCapability } from '$lib/server/auth/require-capability'
import type { CoworkerView, OrgChartEntry } from '$lib/server/coworkers/service'
import type { CoworkerTemplate } from '$lib/server/coworkers/templates'
import { poolFor } from '$lib/server/llm/model-pool'
import { field, runAction } from '$lib/server/org/page-actions'
import { personRun, type PersonRunner } from '$lib/server/org/person-run'

/**
 * Settings → Co-workers (plan/phase-ai-coworkers.md C5): the owner and admins
 * see the company's AI co-workers, create one from a template (title,
 * accountabilities, lens and model prefilled; the model from the pool's chat
 * models, with their family), change its lens, accountabilities, model,
 * reports-to and daily cap, switch it on and off, and remove it. A client of
 * the coworkers.* registry tools (personRun): create and remove always ask
 * for approval, and the admin's click is that approval.
 */

const REASON = 'Only the owner or an admin manages the AI co-workers.'

/** Overridable in tests: the registry runner and the pool's chat models. */
export const _coworkersDeps: { run: PersonRunner; chatModels: () => ChatModelOption[] } = {
  run: personRun,
  chatModels: () => poolFor('chat').map(chatModelOption),
}

export type SeatOption = { id: string; name: string; kind: 'human' | 'coworker' }

export const load: PageServerLoad = async ({ locals }) => {
  const { user } = await requireCapability(locals, 'coworkers.manage', REASON)
  const run = _coworkersDeps.run
  const [list, templates, chart] = await Promise.all([
    run<{ coworkers: CoworkerView[] }>(user, 'coworkers.list', {}),
    run<{ templates: CoworkerTemplate[] }>(user, 'coworkers.templates', {}),
    run<{ people: OrgChartEntry[] }>(user, 'org.chart', {}),
  ])
  return {
    coworkers: list.coworkers.filter((c) => c.removedAt === null),
    templates: templates.templates,
    seats: chart.people.map((p): SeatOption => ({ id: p.id, name: p.name, kind: p.kind })),
    models: _coworkersDeps.chatModels(),
  }
}

type CoworkersAction = 'create' | 'update' | 'enable' | 'disable' | 'remove'

const ATTEMPTED: Record<CoworkersAction, string> = {
  create: 'Creating an AI co-worker (Settings → Co-workers)',
  update: 'Changing an AI co-worker (Settings → Co-workers)',
  enable: 'Switching an AI co-worker on (Settings → Co-workers)',
  disable: 'Switching an AI co-worker off (Settings → Co-workers)',
  remove: 'Removing an AI co-worker (Settings → Co-workers)',
}

const TOOL: Record<CoworkersAction, string> = {
  create: 'coworkers.create',
  update: 'coworkers.update',
  enable: 'coworkers.enable',
  disable: 'coworkers.disable',
  remove: 'coworkers.remove',
}

/** The role card fields as the tools take them; an empty field is left out (the template's or the current value stays). */
function cardInput(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['name', 'title', 'lens', 'model_id'] as const) {
    const v = field(form, key).trim()
    if (v !== '') out[key] = v
  }
  if (form.has('accountabilities')) out.accountabilities = accountabilityLines(field(form, 'accountabilities'))
  // '' = reports to nobody (the co-worker answers to the owner).
  if (form.has('reports_to_user_id')) out.reports_to_user_id = field(form, 'reports_to_user_id') || null
  const cap = field(form, 'daily_cap_usd').trim()
  if (cap !== '') out.daily_cap_usd = Number(cap)
  return out
}

function inputFor(action: CoworkersAction, form: FormData): Record<string, unknown> {
  switch (action) {
    case 'create': {
      const template = field(form, 'template_id')
      return { ...(template ? { template_id: template } : {}), ...cardInput(form) }
    }
    case 'update':
      return { user_id: field(form, 'user_id'), ...cardInput(form) }
    case 'enable':
    case 'disable':
    case 'remove':
      return { user_id: field(form, 'user_id') }
  }
}

function act(action: CoworkersAction) {
  return async (event: Parameters<Actions[string]>[0]) => {
    const { user } = await requireCapability(event.locals, 'coworkers.manage', REASON)
    const form = await event.request.formData()
    const input = inputFor(action, form)
    const userId = action === 'create' ? undefined : field(form, 'user_id')
    return runAction(
      action,
      { attempted: ATTEMPTED[action], tool: TOOL[action], input, userId, log: 'settings/coworkers' },
      () => _coworkersDeps.run(user, TOOL[action], input),
    )
  }
}

export const actions: Actions = {
  create: act('create'),
  update: act('update'),
  enable: act('enable'),
  disable: act('disable'),
  remove: act('remove'),
}
