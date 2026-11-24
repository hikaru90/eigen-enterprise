import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { managerIdsOf } from '$lib/coworkers/org-tree'
import type { PickupCounts, PickupItem } from '$lib/coworkers/pickup-format'
import type { RunItem } from '$lib/coworkers/run-format'
import type { DecisionKindView, DecisionLogEntry } from '$lib/kernel/decision-tools'
import type { EventSubscriptionsView } from '$lib/server/coworkers/event-subscriptions'
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
 *
 * C7, for owner and admins: "Would pick up" — whether it notices new messages
 * in its channels (coworkers.event_subscriptions_get, ?/eventSubscriptions →
 * coworkers.event_subscriptions_set), its recent shadow decisions of kind
 * coworkers.event_mine (decisions.log), the agreement line (decisions.kinds)
 * and a person's mark on a row (?/labelDecision → decisions.label).
 */

const EVENT_MINE_KIND = 'coworkers.event_mine'
const PICKUP_LIMIT = 20

export type WouldPickUp = {
  noticing: boolean
  lastDay: PickupCounts
  agreement: { agreed: number; compared: number } | null
  items: PickupItem[]
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const choice = (v: string | null): 'yes' | 'no' | null => (v === 'yes' || v === 'no' ? v : null)

/** A decision log row of coworkers.event_mine as the profile shows it (its input is the kind's own log view). */
export function _pickupItem(d: DecisionLogEntry): PickupItem {
  const conversationId = text(d.input.conversationId)
  const threadRootId = text(d.input.threadRootId)
  return {
    id: d.id,
    at: text(d.input.at) ?? d.createdAt,
    channel: text(d.input.channel) ?? '',
    privateChannel: d.input.privateChannel === true,
    excerpt: text(d.input.excerpt),
    threadUrl: conversationId
      ? `/messages?c=${encodeURIComponent(conversationId)}${threadRootId ? `&t=${encodeURIComponent(threadRootId)}` : ''}`
      : null,
    jevChoice: choice(d.jevChoice),
    jevConfidence: d.jevConfidence,
    humanChoice: choice(d.humanChoice),
  }
}

async function loadWouldPickUp(run: PersonRunner, user: { id: string }, coworkerId: string): Promise<WouldPickUp> {
  const [subs, log, kinds] = await Promise.all([
    run<EventSubscriptionsView>(user, 'coworkers.event_subscriptions_get', { user_id: coworkerId }),
    run<{ decisions: DecisionLogEntry[] }>(user, 'decisions.log', { kind: EVENT_MINE_KIND, subject_user_id: coworkerId, limit: PICKUP_LIMIT }),
    run<{ kinds: DecisionKindView[] }>(user, 'decisions.kinds', {}),
  ])
  const kind = kinds.kinds.find((k) => k.id === EVENT_MINE_KIND)
  return {
    noticing: subs.kinds.some((k) => k.kind === 'channel_message' && k.on),
    lastDay: subs.lastDay,
    agreement: kind && kind.humanCompared > 0 ? { agreed: kind.humanAgreed, compared: kind.humanCompared } : null,
    items: log.decisions.map(_pickupItem),
  }
}

/** Overridable in tests. */
export const _profileDeps: { run: PersonRunner; role: (userId: string) => Promise<string | null> } = {
  run: personRun,
  role: async (userId) => (await import('$lib/server/auth/user-role')).getUserRole(userId),
}

export type CoworkerCard = Pick<
  CoworkerView,
  'lens' | 'modelId' | 'enabled' | 'dailyCapUsd' | 'accountableHuman' | 'accountableHumans'
> & {
  /** Its @handle, the token that asks it for a turn in Messages (its slug). */
  handle: string
}

export const load: PageServerLoad = async ({ locals, params }) => {
  const user = locals.user
  if (!user) throw redirect(302, '/login')
  const [people, role] = await Promise.all([loadOrgPeople(_profileDeps.run, user), _profileDeps.role(user.id)])
  const person = people.find((p) => p.id === params.id)
  if (!person) error(404, 'No one with this seat is in the org chart.')
  let coworker: CoworkerCard | null = null
  let runs: RunItem[] = []
  let wouldPickUp: WouldPickUp | null = null
  const canManage = role === 'owner' || role === 'admin'
  if (person.kind === 'coworker') {
    const c = await _profileDeps.run<CoworkerView>(user, 'coworkers.get', { user_id: person.id })
    coworker = {
      handle: c.slug,
      lens: c.lens,
      modelId: c.modelId,
      enabled: c.enabled,
      dailyCapUsd: c.dailyCapUsd,
      accountableHuman: c.accountableHuman,
      accountableHumans: c.accountableHumans ?? (c.accountableHuman ? [c.accountableHuman] : []),
    }
    runs = (await _profileDeps.run<{ runs: RunItem[] }>(user, 'coworkers.runs', { user_id: person.id, limit: 30 })).runs
    if (canManage) wouldPickUp = await loadWouldPickUp(_profileDeps.run, user, person.id)
  }
  const managers = managerIdsOf(person).map((id) => ({
    id,
    name: people.find((p) => p.id === id)?.name ?? null,
  }))
  return {
    person,
    manager: managers[0] ?? null,
    managers,
    reports: people
      .filter((p) => managerIdsOf(p).includes(person.id))
      .map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    coworker,
    runs,
    wouldPickUp,
    me: { id: user.id, canManage },
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

  /** "Notice new messages in its channels" (C7): coworkers.event_subscriptions_set with the checked kinds. */
  eventSubscriptions: async ({ locals, request }) => {
    const user = locals.user
    if (!user) throw redirect(302, '/login')
    const form = await request.formData()
    const userId = field(form, 'user_id')
    const input = { user_id: userId, event_kinds: form.getAll('event_kinds').map(String) }
    return runAction(
      'eventSubscriptions',
      { attempted: 'Choosing which events an AI co-worker notices', tool: 'coworkers.event_subscriptions_set', input, userId, log: 'settings/org/[id]' },
      () => _profileDeps.run(user, 'coworkers.event_subscriptions_set', input),
    )
  },

  /** "Theirs / Not theirs" on a "Would pick up" row (C7): decisions.label as the person. */
  labelDecision: async ({ locals, request }) => {
    const user = locals.user
    if (!user) throw redirect(302, '/login')
    const form = await request.formData()
    const userId = field(form, 'user_id')
    const input = { decision_id: field(form, 'decision_id'), choice: field(form, 'choice') }
    return runAction(
      'labelDecision',
      { attempted: "Marking whether an event was an AI co-worker's to act on", tool: 'decisions.label', input, userId, log: 'settings/org/[id]' },
      () => _profileDeps.run(user, 'decisions.label', input),
    )
  },
}
