import { beforeEach, describe, expect, it } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { CoworkerError } from '$lib/server/coworkers/service'
import { _profileDeps, load as profileLoad } from './[id]/+page.server'
import { _orgDeps, actions, load } from './+page.server'

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
  lens: 'Reach first.',
  modelId: 'anthropic/claude-sonnet-5.5',
  enabled: true,
  dailyCapUsd: 2,
  accountableHuman: { id: 'owner', name: 'Olga', reason: 'chain' },
}

const run = (async (user: { id: string }, tool: string, input: unknown) => {
  calls.push({ user: user.id, tool, input })
  if (tool === 'org.chart') return { people }
  if (tool === 'coworkers.list') return { coworkers: [coworker] }
  if (tool === 'coworkers.get') return coworker
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
    expect(calls.map((c) => c.tool)).toEqual(['org.chart', 'coworkers.list', 'coworkers.get'])
    expect(calls[2]!.input).toEqual({ user_id: 'cw1' })
    expect(data.manager).toEqual({ id: 'owner', name: 'Olga' })
    expect(data.coworker).toEqual({
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
    expect(data.coworker).toBeNull()
    expect(data.reports).toEqual([
      { id: 'me', name: 'Ony', kind: 'human' },
      { id: 'cw1', name: 'Mara', kind: 'coworker' },
    ])
  })

  it('answers 404 for someone not in the chart', async () => {
    await expect(profileLoad({ locals, params: { id: 'nobody' } } as never)).rejects.toMatchObject({ status: 404 })
  })
})
