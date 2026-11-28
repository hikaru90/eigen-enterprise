import type { Actions, PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import type { AiAmounts, AiUsageOverview } from '$lib/ai-usage/overview'
import { periodOf, periodRange } from '$lib/ai-usage/view'
import { chatModelOption, type ChatModelOption } from '$lib/coworkers/model-family'
import { requireCapability } from '$lib/server/auth/require-capability'
import type { RhythmTarget, RhythmView } from '$lib/server/coworkers/rhythms'
import type { CoworkerView, OrgChartEntry } from '$lib/server/coworkers/service'
import type { CoworkerTemplate } from '$lib/server/coworkers/templates'
import { chatModels } from '$lib/server/llm/model-pool'
import { cardInput } from '$lib/server/org/form-input'
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
 *
 * C6: each co-worker's rhythms (coworkers.rhythm_list) — add, edit, pause and
 * resume, delete, run now (coworkers.rhythm_create/update/delete/run_now). New
 * rhythms start in the admin's own time zone (Settings).
 */

const REASON = 'Only the owner or an admin manages the AI co-workers.'

/** Overridable in tests: the registry runner and the pool's chat models. */
export const _coworkersDeps: { run: PersonRunner; chatModels: () => ChatModelOption[]; timeZone: (userId: string) => Promise<string> } = {
  run: personRun,
  chatModels: () => chatModels().map(chatModelOption),
  timeZone: async (userId) => {
    const [{ withDbUser }, { getUserPreferredTimezone }] = await Promise.all([import('$lib/server/db'), import('$lib/server/memory/user-timezone')])
    return withDbUser(userId, () => getUserPreferredTimezone(userId))
  },
}

export type CoworkerRhythms = { rhythms: RhythmView[]; targets: RhythmTarget[] }

export type SeatOption = { id: string; name: string; kind: 'human' | 'coworker' }

/** Each co-worker's AI usage of the period (wish acdb941e), from settings.ai_usage_overview's people. */
export type CoworkerUsage = { billing: AiUsageOverview['billing']; byCoworker: Record<string, AiAmounts> }

function usageOf(overview: AiUsageOverview): CoworkerUsage {
  const byCoworker: Record<string, AiAmounts> = {}
  for (const p of overview.people) {
    if (p.kind !== 'coworker') continue
    byCoworker[p.userId] = {
      costUsd: p.costUsd,
      calls: p.calls,
      promptTokens: p.promptTokens,
      completionTokens: p.completionTokens,
      cachedTokens: p.cachedTokens,
      ...(p.providerUsd === undefined ? {} : { providerUsd: p.providerUsd }),
      ...(p.invoicedEur === undefined ? {} : { invoicedEur: p.invoicedEur }),
    }
  }
  return { billing: overview.billing, byCoworker }
}

export const load: PageServerLoad = async ({ locals, url }) => {
  const { user } = await requireCapability(locals, 'coworkers.manage', REASON)
  const usagePeriod = periodOf(url.searchParams.get('usage'))
  if (usagePeriod === null) error(400, 'Choose 7, 30 or 90 days, or all.')
  const run = _coworkersDeps.run
  const [list, templates, chart, overview] = await Promise.all([
    run<{ coworkers: CoworkerView[] }>(user, 'coworkers.list', {}),
    run<{ templates: CoworkerTemplate[] }>(user, 'coworkers.templates', {}),
    run<{ people: OrgChartEntry[] }>(user, 'org.chart', {}),
    run<AiUsageOverview>(user, 'settings.ai_usage_overview', periodRange(usagePeriod, new Date())),
  ])
  const coworkers = list.coworkers.filter((c) => c.removedAt === null)
  const rhythms: Record<string, CoworkerRhythms> = {}
  for (const c of coworkers) rhythms[c.id] = await run<CoworkerRhythms>(user, 'coworkers.rhythm_list', { user_id: c.id })
  return {
    coworkers,
    rhythms,
    usage: usageOf(overview),
    usagePeriod,
    timeZone: await _coworkersDeps.timeZone(user.id),
    templates: templates.templates,
    seats: chart.people.map((p): SeatOption => ({ id: p.id, name: p.name, kind: p.kind })),
    models: _coworkersDeps.chatModels(),
  }
}

type CoworkersAction =
  | 'create'
  | 'update'
  | 'enable'
  | 'disable'
  | 'remove'
  | 'rhythmCreate'
  | 'rhythmUpdate'
  | 'rhythmDelete'
  | 'rhythmRunNow'

const ATTEMPTED: Record<CoworkersAction, string> = {
  create: 'Creating an AI co-worker (Settings → Co-workers)',
  update: 'Changing an AI co-worker (Settings → Co-workers)',
  enable: 'Switching an AI co-worker on (Settings → Co-workers)',
  disable: 'Switching an AI co-worker off (Settings → Co-workers)',
  remove: 'Removing an AI co-worker (Settings → Co-workers)',
  rhythmCreate: 'Adding a rhythm to an AI co-worker (Settings → Co-workers)',
  rhythmUpdate: 'Changing an AI co-worker’s rhythm (Settings → Co-workers)',
  rhythmDelete: 'Deleting an AI co-worker’s rhythm (Settings → Co-workers)',
  rhythmRunNow: 'Running an AI co-worker’s rhythm now (Settings → Co-workers)',
}

const TOOL: Record<CoworkersAction, string> = {
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

/** A rhythm's fields as the tools take them; a field the form did not send is left out (update changes only what is given). */
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

function inputFor(action: CoworkersAction, form: FormData): Record<string, unknown> {
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
  rhythmCreate: act('rhythmCreate'),
  rhythmUpdate: act('rhythmUpdate'),
  rhythmDelete: act('rhythmDelete'),
  rhythmRunNow: act('rhythmRunNow'),
}
