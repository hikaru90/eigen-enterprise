import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({ roleMock: vi.fn(async (): Promise<string | null> => 'admin') }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { KernelError } from '$lib/kernel/errors'
import { CoworkerError } from '$lib/server/coworkers/service'
import { _coworkersDeps, actions, load } from './+page.server'

/**
 * Settings → Co-workers (plan/phase-ai-coworkers.md C5): the load reads the
 * coworkers.* / org.chart registry tools as the signed-in admin, every form
 * action calls its one tool with the tool's input, and a change that waits
 * for approval says so instead of failing.
 */

type Call = { user: string; tool: string; input: unknown }
let calls: Call[] = []
let answer: (tool: string, input: unknown) => unknown = () => ({})

const coworker = {
  id: 'cw1',
  name: 'Mara',
  email: 'mara.cw1@coworker.invalid',
  slug: 'mara',
  title: 'Marketing Manager',
  accountabilities: ['Pipeline'],
  lens: 'Cares about reach.',
  modelId: 'anthropic/claude-sonnet-5.5',
  enabled: true,
  dailyCapUsd: 2,
  templateId: 'marketing-manager',
  reportsToUserId: null,
  accountableHuman: { id: 'owner', name: 'Olga', reason: 'owner' },
  agentId: 'coworker-cw1',
  createdBy: 'owner',
  createdAt: '2026-11-23T10:00:00.000Z',
  updatedAt: '2026-11-23T10:00:00.000Z',
  removedAt: null,
}

beforeEach(() => {
  calls = []
  roleMock.mockResolvedValue('admin')
  answer = (tool) => {
    if (tool === 'coworkers.list') return { coworkers: [coworker, { ...coworker, id: 'gone', removedAt: '2026-11-23T11:00:00.000Z' }] }
    if (tool === 'coworkers.templates') return { templates: [{ id: 'designer', title: 'Designer', accountabilities: ['Look'], lens: 'l', suggestedModelId: 'qwen/qwen3.8-flash', suggestedDailyCapUsd: 1 }] }
    if (tool === 'org.chart') return { people: [{ id: 'owner', name: 'Olga', kind: 'human' }, { id: 'cw1', name: 'Mara', kind: 'coworker' }] }
    return coworker
  }
  _coworkersDeps.run = (async (user: { id: string }, tool: string, input: unknown) => {
    calls.push({ user: user.id, tool, input })
    return answer(tool, input)
  }) as typeof _coworkersDeps.run
  _coworkersDeps.chatModels = () => [
    { id: 'anthropic/claude-sonnet-5.5', family: 'Anthropic', name: 'claude-sonnet-5.5', note: 'n', recommended: false },
  ]
})

const locals = { user: { id: 'admin1' } }
const ev = (form: Record<string, string> = {}) =>
  ({
    locals,
    request: new Request('http://x/settings/coworkers', { method: 'POST', body: new URLSearchParams(form) }),
  }) as never

describe('load', () => {
  it('reads the co-workers (removed ones left out), the templates and the seats through the registry, plus the pool chat models', async () => {
    const data = (await load({ locals } as never)) as Record<string, unknown>
    expect(calls.map((c) => [c.user, c.tool])).toEqual([
      ['admin1', 'coworkers.list'],
      ['admin1', 'coworkers.templates'],
      ['admin1', 'org.chart'],
    ])
    expect((data.coworkers as { id: string }[]).map((c) => c.id)).toEqual(['cw1'])
    expect(data.seats).toEqual([
      { id: 'owner', name: 'Olga', kind: 'human' },
      { id: 'cw1', name: 'Mara', kind: 'coworker' },
    ])
    expect((data.models as { family: string }[])[0]!.family).toBe('Anthropic')
  })

  it('refuses a member (403) without reading anything', async () => {
    roleMock.mockResolvedValue('member')
    await expect(load({ locals } as never)).rejects.toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })

  it('the live pool offers only chat models, each with its family', async () => {
    const { poolFor } = await import('$lib/server/llm/model-pool')
    const { chatModelOption } = await import('$lib/coworkers/model-family')
    const live = poolFor('chat').map(chatModelOption)
    expect(live.length).toBeGreaterThan(3)
    expect(new Set(live.map((m) => m.family)).size).toBeGreaterThan(3)
  })
})

describe('actions', () => {
  it('create → coworkers.create with the template and the edited card', async () => {
    const out = await actions.create(
      ev({
        template_id: 'designer',
        name: 'Dana',
        title: 'Designer',
        accountabilities: 'Look and feel\n\n Brand consistency ',
        lens: 'Taste first.',
        model_id: 'qwen/qwen3.8-flash',
        reports_to_user_id: 'owner',
        daily_cap_usd: '1.5',
      }),
    )
    expect(calls).toEqual([
      {
        user: 'admin1',
        tool: 'coworkers.create',
        input: {
          template_id: 'designer',
          name: 'Dana',
          title: 'Designer',
          lens: 'Taste first.',
          model_id: 'qwen/qwen3.8-flash',
          accountabilities: ['Look and feel', 'Brand consistency'],
          reports_to_user_id: 'owner',
          daily_cap_usd: 1.5,
        },
      },
    ])
    expect(out).toEqual({ action: 'create', ok: true })
  })

  it('create from blank leaves out the template; reports-to "" is nobody (answers to the owner)', async () => {
    await actions.create(ev({ template_id: '', title: 'Analyst', accountabilities: 'Numbers', lens: 'Facts', model_id: 'm/x', reports_to_user_id: '', daily_cap_usd: '1' }))
    expect(calls[0]!.input).toEqual({
      title: 'Analyst',
      lens: 'Facts',
      model_id: 'm/x',
      accountabilities: ['Numbers'],
      reports_to_user_id: null,
      daily_cap_usd: 1,
    })
  })

  it('update → coworkers.update with the co-worker and its card', async () => {
    const out = await actions.update(ev({ user_id: 'cw1', name: 'Mara', title: 'Marketing Manager', accountabilities: 'Pipeline', lens: 'Reach', model_id: 'google/gemini-3.8-flash', reports_to_user_id: '', daily_cap_usd: '3' }))
    expect(calls[0]).toMatchObject({
      tool: 'coworkers.update',
      input: { user_id: 'cw1', model_id: 'google/gemini-3.8-flash', reports_to_user_id: null, daily_cap_usd: 3, accountabilities: ['Pipeline'] },
    })
    expect(out).toEqual({ action: 'update', ok: true, userId: 'cw1' })
  })

  it.each([
    ['enable', 'coworkers.enable'],
    ['disable', 'coworkers.disable'],
    ['remove', 'coworkers.remove'],
  ] as const)('%s → %s with the user id', async (action, tool) => {
    const out = await actions[action](ev({ user_id: 'cw1' }))
    expect(calls).toEqual([{ user: 'admin1', tool, input: { user_id: 'cw1' } }])
    expect(out).toEqual({ action, ok: true, userId: 'cw1' })
  })

  it('a change still waiting for approval says so (not an error)', async () => {
    _coworkersDeps.run = (async () => {
      throw new KernelError('approval_required', 'tool coworkers.remove is awaiting approval', { approvalId: 'a1', tool: 'coworkers.remove' })
    }) as typeof _coworkersDeps.run
    expect(await actions.remove(ev({ user_id: 'cw1' }))).toEqual({ action: 'remove', waiting: true, userId: 'cw1' })
  })

  it('a refusal by the service comes back with its sentence and the agent report', async () => {
    _coworkersDeps.run = (async () => {
      throw new CoworkerError('org_cycle', 'Mara cannot report to someone who reports to Mara.')
    }) as typeof _coworkersDeps.run
    const out = (await actions.update(ev({ user_id: 'cw1', reports_to_user_id: 'x' }))) as { status: number; data: Record<string, unknown> }
    expect(out.status).toBe(400)
    expect(out.data).toMatchObject({ action: 'update', userId: 'cw1', error: 'Mara cannot report to someone who reports to Mara.' })
    expect(out.data.agent).toMatchObject({ tool: 'coworkers.update', code: 'CoworkerError' })
  })

  it('a field the tool schema refuses is named the way the form shows it', async () => {
    _coworkersDeps.run = (async () => {
      throw new KernelError('invalid_input', 'bad', { tool: 'coworkers.create', issues: [{ path: 'daily_cap_usd', message: 'NaN' }] })
    }) as typeof _coworkersDeps.run
    const out = (await actions.create(ev({ daily_cap_usd: 'abc' }))) as { status: number; data: Record<string, unknown> }
    expect(out.status).toBe(400)
    expect(out.data.error).toMatch(/the daily cap/)
  })

  it('a member posting the form is refused before any tool runs', async () => {
    roleMock.mockResolvedValue('member')
    await expect(actions.create(ev({ title: 'x' }))).rejects.toMatchObject({ status: 403 })
    expect(calls).toEqual([])
  })
})
