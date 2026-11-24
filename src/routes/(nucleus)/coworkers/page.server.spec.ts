import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<string | null> => 'admin'),
}))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { KernelError } from '$lib/kernel/errors'
import { CoworkerError } from '$lib/server/coworkers/service'
import { _coworkersPageDeps, actions, load } from './+page.server'

type Call = { user: string; tool: string; input: unknown }
let calls: Call[] = []
let answer: (tool: string, input: unknown) => unknown = () => ({})

const people = [
  {
    id: 'owner',
    name: 'Olga',
    kind: 'human',
    role: 'owner',
    title: 'CEO',
    accountabilities: [],
    reportsToUserId: null,
    accountableHuman: null,
    enabled: null,
  },
  {
    id: 'me',
    name: 'Ony',
    kind: 'human',
    role: 'member',
    title: null,
    accountabilities: [],
    reportsToUserId: 'owner',
    accountableHuman: null,
    enabled: null,
  },
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
  reportsToUserId: 'owner',
  accountableHuman: { id: 'owner', name: 'Olga', reason: 'chain' },
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
    if (tool === 'org.chart') return { people }
    if (tool === 'coworkers.list') {
      return {
        coworkers: [
          coworker,
          { ...coworker, id: 'gone', removedAt: '2026-11-23T11:00:00.000Z' },
        ],
      }
    }
    if (tool === 'coworkers.templates') {
      return {
        templates: [
          {
            id: 'designer',
            title: 'Designer',
            accountabilities: ['Look'],
            lens: 'l',
            suggestedModelId: 'qwen/qwen3.8-flash',
            suggestedDailyCapUsd: 1,
          },
        ],
      }
    }
    if (tool === 'coworkers.rhythm_list') {
      return { rhythms: [], targets: [{ id: 'c1', title: '#marketing', kind: 'channel' }] }
    }
    return coworker
  }
  _coworkersPageDeps.run = (async (user: { id: string }, tool: string, input: unknown) => {
    calls.push({ user: user.id, tool, input })
    return answer(tool, input)
  }) as typeof _coworkersPageDeps.run
  _coworkersPageDeps.role = roleMock
  _coworkersPageDeps.timeZone = async () => 'Europe/Berlin'
  _coworkersPageDeps.chatModels = () => [
    {
      id: 'anthropic/claude-sonnet-5.5',
      family: 'Anthropic',
      name: 'claude-sonnet-5.5',
      note: 'n',
      recommended: false,
    },
  ]
})

const locals = { user: { id: 'admin1' } }
const memberLocals = { user: { id: 'me' } }
const ev = (form: Record<string, string> = {}, loc = locals) =>
  ({
    locals: loc,
    request: new Request('http://x/coworkers', {
      method: 'POST',
      body: new URLSearchParams(form),
    }),
  }) as never

describe('load', () => {
  it('redirects signed-out visitors to /login', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 })
  })

  it('for a member: loads org people and me without calling management tools', async () => {
    roleMock.mockResolvedValue('member')
    const data = (await load({ locals: memberLocals } as never)) as Record<string, unknown>
    expect(calls.map((c) => [c.user, c.tool])).toEqual([
      ['me', 'org.chart'],
      ['me', 'coworkers.list'],
    ])
    expect(data.me).toEqual({ id: 'me', canManage: false })
    expect((data.people as { id: string; modelId: string | null }[]).map((p) => [p.id, p.modelId])).toEqual([
      ['owner', null],
      ['me', null],
      ['cw1', 'anthropic/claude-sonnet-5.5'],
    ])
    expect(data.coworkers).toEqual([])
    expect(data.rhythms).toEqual({})
    expect(data.timeZone).toBeNull()
    expect(data.templates).toEqual([])
    expect(data.models).toEqual([])
    expect(data.seats).toEqual([])
  })

  it('for an admin/owner: loads people, active coworkers, rhythms, timezone, templates, models, and seats', async () => {
    const data = (await load({ locals } as never)) as Record<string, unknown>
    expect(calls.map((c) => [c.user, c.tool])).toEqual([
      ['admin1', 'org.chart'],
      ['admin1', 'coworkers.list'],
      ['admin1', 'coworkers.templates'],
      ['admin1', 'coworkers.rhythm_list'],
    ])
    expect(calls[3]!.input).toEqual({ user_id: 'cw1' })
    expect(data.me).toEqual({ id: 'admin1', canManage: true })
    expect((data.coworkers as { id: string }[]).map((c) => c.id)).toEqual(['cw1'])
    expect(data.rhythms).toEqual({
      cw1: { rhythms: [], targets: [{ id: 'c1', title: '#marketing', kind: 'channel' }] },
    })
    expect(data.timeZone).toBe('Europe/Berlin')
    expect((data.templates as { id: string }[]).map((t) => t.id)).toEqual(['designer'])
    expect((data.models as { family: string }[])[0]!.family).toBe('Anthropic')
    expect(data.seats).toEqual([
      { id: 'owner', name: 'Olga', kind: 'human' },
      { id: 'me', name: 'Ony', kind: 'human' },
      { id: 'cw1', name: 'Mara', kind: 'coworker' },
    ])
  })
})

describe('actions', () => {
  it('setPosition: member updates own seat without reports_to_user_id; admin includes reports_to_user_id', async () => {
    roleMock.mockResolvedValue('member')
    const memberOut = await actions.setPosition(
      ev({ user_id: 'me', title: ' Designer ', accountabilities: 'Look\n\nFeel' }, memberLocals),
    )
    expect(calls).toEqual([
      {
        user: 'me',
        tool: 'org.set_position',
        input: { user_id: 'me', title: 'Designer', accountabilities: ['Look', 'Feel'] },
      },
    ])
    expect(memberOut).toEqual({ action: 'setPosition', ok: true, userId: 'me' })

    calls = []
    roleMock.mockResolvedValue('admin')
    await actions.setPosition(
      ev({ user_id: 'cw1', title: '', accountabilities: '', reports_to_user_id: '' }),
    )
    expect(calls[0]!.input).toEqual({
      user_id: 'cw1',
      title: null,
      accountabilities: [],
      reports_to_user_id: null,
    })
  })

  it('setPosition handles waiting-for-approval, forbidden errors, and signed-out redirects', async () => {
    _coworkersPageDeps.run = (async () => {
      throw new KernelError('approval_required', 'waiting', {
        approvalId: 'a1',
        tool: 'org.set_position',
      })
    }) as typeof _coworkersPageDeps.run
    expect(
      await actions.setPosition(ev({ user_id: 'me', title: 'x', accountabilities: '' }, memberLocals)),
    ).toEqual({ action: 'setPosition', waiting: true, userId: 'me' })

    _coworkersPageDeps.run = (async () => {
      throw new CoworkerError('forbidden', 'You can only change your own title and accountabilities.')
    }) as typeof _coworkersPageDeps.run
    const refused = (await actions.setPosition(
      ev({ user_id: 'owner', title: 'x', accountabilities: '' }, memberLocals),
    )) as { status: number; data: Record<string, unknown> }
    expect(refused.status).toBe(403)
    expect(refused.data).toMatchObject({
      action: 'setPosition',
      userId: 'owner',
      error: 'You can only change your own title and accountabilities.',
    })

    await expect(
      actions.setPosition(ev({ user_id: 'me', title: 'x' }, { user: null } as never)),
    ).rejects.toMatchObject({ status: 302 })
  })

  it('create → coworkers.create with template or blank card', async () => {
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

    calls = []
    await actions.create(
      ev({
        template_id: '',
        title: 'Analyst',
        accountabilities: 'Numbers',
        lens: 'Facts',
        model_id: 'm/x',
        reports_to_user_id: '',
        daily_cap_usd: '1',
      }),
    )
    expect(calls[0]!.input).toEqual({
      title: 'Analyst',
      lens: 'Facts',
      model_id: 'm/x',
      accountabilities: ['Numbers'],
      reports_to_user_id: null,
      daily_cap_usd: 1,
    })
  })

  it('update, enable, disable, and remove invoke their coworkers.* tools', async () => {
    const up = await actions.update(
      ev({
        user_id: 'cw1',
        name: 'Mara',
        title: 'Marketing Manager',
        accountabilities: 'Pipeline',
        lens: 'Reach',
        model_id: 'google/gemini-3.8-flash',
        reports_to_user_id: '',
        daily_cap_usd: '3',
      }),
    )
    expect(up).toEqual({ action: 'update', ok: true, userId: 'cw1' })
    expect(calls[0]).toMatchObject({
      tool: 'coworkers.update',
      input: {
        user_id: 'cw1',
        model_id: 'google/gemini-3.8-flash',
        reports_to_user_id: null,
        daily_cap_usd: 3,
        accountabilities: ['Pipeline'],
      },
    })

    for (const [action, tool] of [
      ['enable', 'coworkers.enable'],
      ['disable', 'coworkers.disable'],
      ['remove', 'coworkers.remove'],
    ] as const) {
      calls = []
      const out = await actions[action](ev({ user_id: 'cw1' }))
      expect(calls).toEqual([{ user: 'admin1', tool, input: { user_id: 'cw1' } }])
      expect(out).toEqual({ action, ok: true, userId: 'cw1' })
    }
  })

  it('rhythmCreate, rhythmUpdate, rhythmDelete, and rhythmRunNow invoke their coworkers.rhythm_* tools', async () => {
    const body = new URLSearchParams([
      ['user_id', 'cw1'],
      ['weekdays_sent', '1'],
      ['weekdays', 'MO'],
      ['weekdays', 'FR'],
      ['time', '09:00'],
      ['time_zone', 'Europe/Berlin'],
      ['conversation_id', 'c1'],
      ['instruction', ' Post the standup. '],
    ])
    const created = await actions.rhythmCreate({
      locals,
      request: new Request('http://x/coworkers', { method: 'POST', body }),
    } as never)
    expect(created).toEqual({ action: 'rhythmCreate', ok: true, userId: 'cw1' })
    expect(calls[0]).toEqual({
      user: 'admin1',
      tool: 'coworkers.rhythm_create',
      input: {
        user_id: 'cw1',
        weekdays: ['MO', 'FR'],
        time: '09:00',
        time_zone: 'Europe/Berlin',
        conversation_id: 'c1',
        instruction: 'Post the standup.',
      },
    })

    calls = []
    await actions.rhythmUpdate(ev({ user_id: 'cw1', rhythm_id: 'r1', enabled: 'false' }))
    await actions.rhythmDelete(ev({ user_id: 'cw1', rhythm_id: 'r1' }))
    await actions.rhythmRunNow(ev({ user_id: 'cw1', rhythm_id: 'r1' }))
    expect(calls.map((c) => [c.tool, c.input])).toEqual([
      ['coworkers.rhythm_update', { rhythm_id: 'r1', enabled: false }],
      ['coworkers.rhythm_delete', { rhythm_id: 'r1' }],
      ['coworkers.rhythm_run_now', { rhythm_id: 'r1' }],
    ])
  })

  it('handles approval waiting, CoworkerError, invalid_input field labels, and member 403 refusals', async () => {
    _coworkersPageDeps.run = (async () => {
      throw new KernelError('approval_required', 'waiting', {
        approvalId: 'a1',
        tool: 'coworkers.remove',
      })
    }) as typeof _coworkersPageDeps.run
    expect(await actions.remove(ev({ user_id: 'cw1' }))).toEqual({
      action: 'remove',
      waiting: true,
      userId: 'cw1',
    })

    _coworkersPageDeps.run = (async () => {
      throw new CoworkerError('org_cycle', 'Mara cannot report to someone who reports to Mara.')
    }) as typeof _coworkersPageDeps.run
    const cycleErr = (await actions.update(
      ev({ user_id: 'cw1', reports_to_user_id: 'x' }),
    )) as { status: number; data: Record<string, unknown> }
    expect(cycleErr.status).toBe(400)
    expect(cycleErr.data).toMatchObject({
      action: 'update',
      userId: 'cw1',
      error: 'Mara cannot report to someone who reports to Mara.',
    })
    expect(cycleErr.data.agent).toMatchObject({ tool: 'coworkers.update', code: 'CoworkerError' })

    _coworkersPageDeps.run = (async () => {
      throw new KernelError('invalid_input', 'bad', {
        tool: 'coworkers.create',
        issues: [{ path: 'daily_cap_usd', message: 'NaN' }],
      })
    }) as typeof _coworkersPageDeps.run
    const fieldErr = (await actions.create(ev({ daily_cap_usd: 'abc' }))) as {
      status: number
      data: Record<string, unknown>
    }
    expect(fieldErr.status).toBe(400)
    expect(fieldErr.data.error).toMatch(/the daily cap/)

    roleMock.mockResolvedValue('member')
    for (const action of [
      'create',
      'update',
      'enable',
      'disable',
      'remove',
      'rhythmCreate',
      'rhythmUpdate',
      'rhythmDelete',
      'rhythmRunNow',
    ] as const) {
      await expect(actions[action](ev({ user_id: 'cw1', rhythm_id: 'r1' }, memberLocals))).rejects.toMatchObject({
        status: 403,
      })
    }
    expect(calls).toEqual([])
  })
})
