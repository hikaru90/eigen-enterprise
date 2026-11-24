import { beforeEach, describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { CoworkerError } from '$lib/server/coworkers/service'
import { _orgDeps, actions, load } from './+page.server'
import { _profileDeps, actions as profileActions, load as profileLoad } from './[id]/+page.server'

/**
 * Settings → Org chart and a seat's profile (plan/phase-ai-coworkers.md C5):
 * the loads read org.chart + coworkers.list (+ coworkers.get) through the
 * registry as the signed-in person; "Save seat" calls org.set_position with
 * the seat's input, reports-to only from the owner's and admins' form.
 */

type Call = { user: string; tool: string; input: unknown }
let calls: Call[] = []
let role: string | null = 'member'

const people = [
  { id: 'owner', name: 'Olga', kind: 'human', role: 'owner', title: 'CEO', accountabilities: [], reportsToUserId: null, accountableHuman: null, enabled: null },
  { id: 'me', name: 'Ony', kind: 'human', role: 'member', title: null, accountabilities: [], reportsToUserId: 'owner', accountableHuman: null, enabled: null },
  {
    id: 'cw1',
    name: 'Mara',
    kind: 'coworker',
    role: 'member',
    title: 'Marketing Manager',
    accountabilities: ['Pipeline'],
    reportsToUserId: 'owner',
    accountableHuman: { id: 'owner', name: 'Olga', reason: 'chain' },
    enabled: true,
  },
]
const coworker = {
  id: 'cw1',
  slug: 'mia-mwujrl74',
  lens: 'Reach first.',
  modelId: 'anthropic/claude-sonnet-5.5',
  enabled: true,
  dailyCapUsd: 2,
  accountableHuman: { id: 'owner', name: 'Olga', reason: 'chain' },
}

const counts = { claimed: 0, observed: 0, queued: 0, skipped_rate_limit: 0, skipped_daily_cap: 0, skipped_author_cap: 0, failed: 0 }
const pickupRow = {
  id: 'd1',
  kind: 'coworkers.event_mine',
  input: { conversationId: 'c-launch', threadRootId: 'm1', channel: 'launch', privateChannel: false, excerpt: 'Draft the post.', at: '2026-11-23T09:00:00.000Z' },
  jevChoice: 'yes',
  jevConfidence: 0.81,
  humanChoice: null,
  createdAt: '2026-11-23T09:00:01.000Z',
}

const run = (async (user: { id: string }, tool: string, input: unknown) => {
  calls.push({ user: user.id, tool, input })
  if (tool === 'org.chart') return { people }
  if (tool === 'coworkers.list') return { coworkers: [coworker] }
  if (tool === 'coworkers.get') return coworker
  if (tool === 'coworkers.runs') return { runs: [{ id: 'run-1', triggerKind: 'rhythm', status: 'done' }] }
  if (tool === 'coworkers.notice_seen') return { runId: 'run-1', seen: true }
  if (tool === 'coworkers.event_subscriptions_get') {
    return { userId: 'cw1', kinds: [{ kind: 'channel_message', on: true }], lastHour: counts, lastDay: { ...counts, observed: 3, skipped_author_cap: 1 } }
  }
  if (tool === 'decisions.log') return { decisions: [pickupRow] }
  if (tool === 'decisions.kinds') return { kinds: [{ id: 'coworkers.event_mine', humanCompared: 4, humanAgreed: 3 }] }
  if (tool === 'coworkers.event_subscriptions_set' || tool === 'decisions.label') return {}
  return people[1]
}) as typeof _orgDeps.run

beforeEach(() => {
  calls = []
  role = 'member'
  _orgDeps.run = run
  _orgDeps.role = async () => role
  _profileDeps.run = run
  _profileDeps.role = async () => role
})

const locals = { user: { id: 'me' } }
const ev = (form: Record<string, string>) =>
  ({ locals, request: new Request('http://x/settings/org', { method: 'POST', body: new URLSearchParams(form) }) }) as never

describe('org chart load', () => {
  it('reads org.chart and coworkers.list as the person; each co-worker carries its model', async () => {
    const data = (await load({ locals } as never)) as { people: { id: string; modelId: string | null }[]; me: unknown }
    expect(calls.map((c) => [c.user, c.tool])).toEqual([
      ['me', 'org.chart'],
      ['me', 'coworkers.list'],
    ])
    expect(data.people.map((p) => [p.id, p.modelId])).toEqual([
      ['owner', null],
      ['me', null],
      ['cw1', 'anthropic/claude-sonnet-5.5'],
    ])
    expect(data.me).toEqual({ id: 'me', canManage: false })
  })

  it('the owner and admins may manage every seat', async () => {
    role = 'admin'
    expect(((await load({ locals } as never)) as { me: unknown }).me).toEqual({ id: 'me', canManage: true })
  })

  it('sends a signed-out visitor to sign in', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 })
  })
})

describe('setPosition', () => {
  it("a member's own seat → org.set_position with title and accountabilities only (their form sends no reports-to)", async () => {
    const out = await actions.setPosition(ev({ user_id: 'me', title: ' Designer ', accountabilities: 'Look\n\nFeel' }))
    expect(calls).toEqual([{ user: 'me', tool: 'org.set_position', input: { user_id: 'me', title: 'Designer', accountabilities: ['Look', 'Feel'] } }])
    expect(out).toEqual({ action: 'setPosition', ok: true, userId: 'me' })
  })

  it('an empty title clears it; reports-to "" is nobody', async () => {
    await actions.setPosition(ev({ user_id: 'cw1', title: '', accountabilities: '', reports_to_user_id: '' }))
    expect(calls[0]!.input).toEqual({ user_id: 'cw1', title: null, accountabilities: [], reports_to_user_id: null })
  })

  it('a change waiting for approval says so', async () => {
    _orgDeps.run = (async () => {
      throw new KernelError('approval_required', 'tool org.set_position requires approval', { approvalId: 'a1', tool: 'org.set_position' })
    }) as typeof _orgDeps.run
    expect(await actions.setPosition(ev({ user_id: 'me', title: 'x', accountabilities: '' }))).toEqual({ action: 'setPosition', waiting: true, userId: 'me' })
  })

  it("someone else's seat refused by the service comes back as a 403 with its sentence", async () => {
    _orgDeps.run = (async () => {
      throw new CoworkerError('forbidden', 'You can only change your own title and accountabilities.')
    }) as typeof _orgDeps.run
    const out = (await actions.setPosition(ev({ user_id: 'owner', title: 'x', accountabilities: '' }))) as { status: number; data: Record<string, unknown> }
    expect(out.status).toBe(403)
    expect(out.data).toMatchObject({ action: 'setPosition', userId: 'owner', error: 'You can only change your own title and accountabilities.' })
  })
})

describe('profile load', () => {
  it("a co-worker's profile: its seat, manager, and role card from coworkers.get", async () => {
    const data = (await profileLoad({ locals, params: { id: 'cw1' } } as never)) as Record<string, unknown>
    expect(calls.map((c) => c.tool)).toEqual(['org.chart', 'coworkers.list', 'coworkers.get', 'coworkers.runs'])
    expect(calls[2]!.input).toEqual({ user_id: 'cw1' })
    // C6: its run log.
    expect(calls[3]!.input).toEqual({ user_id: 'cw1', limit: 30 })
    expect(data.runs).toEqual([{ id: 'run-1', triggerKind: 'rhythm', status: 'done' }])
    expect(data.manager).toEqual({ id: 'owner', name: 'Olga' })
    expect(data.coworker).toEqual({
      handle: 'mia-mwujrl74',
      lens: 'Reach first.',
      modelId: 'anthropic/claude-sonnet-5.5',
      enabled: true,
      dailyCapUsd: 2,
      accountableHuman: { id: 'owner', name: 'Olga', reason: 'chain' },
    })
  })

  it("a person's profile has no co-worker card and lists their direct reports", async () => {
    const data = (await profileLoad({ locals, params: { id: 'owner' } } as never)) as Record<string, unknown>
    expect(calls.map((c) => c.tool)).not.toContain('coworkers.get')
    expect(calls.map((c) => c.tool)).not.toContain('coworkers.runs')
    expect(data.coworker).toBeNull()
    expect(data.runs).toEqual([])
    expect(data.reports).toEqual([
      { id: 'me', name: 'Ony', kind: 'human' },
      { id: 'cw1', name: 'Mara', kind: 'coworker' },
    ])
  })

  it('"Got it" on a co-worker row in Needs you → coworkers.notice_seen as the person (C6)', async () => {
    const out = await profileActions.noticeSeen({
      locals,
      request: new Request('http://x/settings/org/cw1', { method: 'POST', body: new URLSearchParams({ run_id: 'run-1' }) }),
    } as never)
    expect(calls).toEqual([expect.objectContaining({ tool: 'coworkers.notice_seen', input: { run_id: 'run-1' } })])
    expect(out).toEqual({ action: 'noticeSeen', ok: true })
  })

  it('owner and admins see "Would pick up" (C7): subscriptions, the shadow decisions about it, agreement', async () => {
    role = 'admin'
    const data = (await profileLoad({ locals, params: { id: 'cw1' } } as never)) as Record<string, unknown>
    expect(calls.map((c) => c.tool)).toEqual([
      'org.chart',
      'coworkers.list',
      'coworkers.get',
      'coworkers.runs',
      'coworkers.event_subscriptions_get',
      'decisions.log',
      'decisions.kinds',
    ])
    expect(calls[5]!.input).toEqual({ kind: 'coworkers.event_mine', subject_user_id: 'cw1', limit: 20 })
    expect(data.wouldPickUp).toEqual({
      noticing: true,
      lastDay: { ...counts, observed: 3, skipped_author_cap: 1 },
      agreement: { agreed: 3, compared: 4 },
      items: [
        {
          id: 'd1',
          at: '2026-11-23T09:00:00.000Z',
          channel: 'launch',
          privateChannel: false,
          excerpt: 'Draft the post.',
          threadUrl: '/messages?c=c-launch&t=m1',
          jevChoice: 'yes',
          jevConfidence: 0.81,
          humanChoice: null,
        },
      ],
    })
  })

  it('a member sees no "Would pick up"', async () => {
    const data = (await profileLoad({ locals, params: { id: 'cw1' } } as never)) as Record<string, unknown>
    expect(data.wouldPickUp).toBeNull()
    expect(calls.map((c) => c.tool)).not.toContain('decisions.log')
  })

  it('?/eventSubscriptions → coworkers.event_subscriptions_set with the checked kinds; ?/labelDecision → decisions.label', async () => {
    const on = await profileActions.eventSubscriptions(ev({ user_id: 'cw1', event_kinds: 'channel_message' }))
    const off = await profileActions.eventSubscriptions(ev({ user_id: 'cw1' }))
    const label = await profileActions.labelDecision(ev({ user_id: 'cw1', decision_id: 'd1', choice: 'no' }))
    expect(calls).toEqual([
      expect.objectContaining({ user: 'me', tool: 'coworkers.event_subscriptions_set', input: { user_id: 'cw1', event_kinds: ['channel_message'] } }),
      expect.objectContaining({ tool: 'coworkers.event_subscriptions_set', input: { user_id: 'cw1', event_kinds: [] } }),
      expect.objectContaining({ tool: 'decisions.label', input: { decision_id: 'd1', choice: 'no' } }),
    ])
    expect(on).toEqual({ action: 'eventSubscriptions', ok: true, userId: 'cw1' })
    expect(off).toEqual({ action: 'eventSubscriptions', ok: true, userId: 'cw1' })
    expect(label).toEqual({ action: 'labelDecision', ok: true, userId: 'cw1' })
  })

  it('answers 404 for someone not in the chart', async () => {
    await expect(profileLoad({ locals, params: { id: 'nobody' } } as never)).rejects.toMatchObject({ status: 404 })
  })
})
