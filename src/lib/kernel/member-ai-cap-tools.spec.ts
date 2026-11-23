import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import {
  createMemberAiCapTools,
  KERNEL_MEMBER_AI_CAP_TOOL_NAMES,
  type MemberAiCapPort,
  type MemberAiUsageView,
} from './member-ai-cap-tools'
import { delegatedPrincipal } from './principals'
import { KernelRegistry } from './registry'

const admin: ToolContext = { principal: { id: 'u-admin', kind: 'human', roles: ['admin', 'member'] }, requestId: 'r1' }
const member: ToolContext = { principal: { id: 'u-mia', kind: 'human', roles: ['member'] }, requestId: 'r2' }
const brainAsMember: ToolContext = {
  principal: delegatedPrincipal({ id: 'u-mia', roles: ['member'] }, 'orchestrator'),
  requestId: 'r3',
}
const bareAgent: ToolContext = { principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] }, requestId: 'r4' }

function makePort() {
  const sets: Array<{ value: number | null; actor: string }> = []
  let cap: number | null = null
  const usageCalls: string[] = []
  const port: MemberAiCapPort = {
    readCapUsd: async () => cap,
    setCapUsd: async (value, actor) => {
      sets.push({ value, actor })
      cap = value
    },
    usageToday: async (userId): Promise<MemberAiUsageView> => {
      usageCalls.push(userId)
      return {
        role: 'member',
        capUsd: cap,
        capApplies: cap !== null,
        spentUsd: 0.25,
        remainingUsd: cap === null ? null : Math.max(0, cap - 0.25),
        resetsAt: '2026-11-24T00:00:00.000Z',
      }
    },
  }
  return { port, sets, usageCalls }
}

function makeRegistry(mode: 'ask' | 'reasonable' | 'allow_all' = 'allow_all') {
  const approvals = new InMemoryApprovalStore()
  const approvalMode = new InMemoryApprovalModeStore(mode)
  const events = new InMemoryEventSink()
  const registry = new KernelRegistry({
    eventSink: events,
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), approvalMode),
    approvalStore: approvals,
  })
  const fx = makePort()
  for (const tool of createMemberAiCapTools({ port: fx.port })) registry.register(tool)
  return { registry, approvals, events, ...fx }
}

/** The always-on approval wall: a person decides, then the same call runs. */
async function approvedRun(
  fx: ReturnType<typeof makeRegistry>,
  tool: string,
  input: unknown,
  ctx: ToolContext,
): Promise<unknown> {
  const gated = await fx.registry.execute(tool, input, ctx).catch((e) => e)
  expect(gated).toMatchObject({ code: 'approval_required' })
  await fx.approvals.decide(gated.details.approvalId, 'approved', ctx.principal.id)
  return fx.registry.execute(tool, input, ctx)
}

describe('member AI cap tools surface', () => {
  it('is the cap read, the cap change and a person’s own usage today', () => {
    const { port } = makePort()
    const tools = createMemberAiCapTools({ port })
    expect(tools.map((t) => t.name)).toEqual([...KERNEL_MEMBER_AI_CAP_TOOL_NAMES])
    expect(KERNEL_MEMBER_AI_CAP_TOOL_NAMES).toEqual([
      'settings.member_ai_cap_get',
      'settings.member_ai_cap_set',
      'settings.my_ai_usage',
    ])
    const set = tools.find((t) => t.name === 'settings.member_ai_cap_set')
    expect(set).toMatchObject({ auditClass: 'mutate', approvalAlways: true, approvalRisk: 'internal' })
    expect(set?.permission.roles).toEqual(['admin'])
    expect(tools.find((t) => t.name === 'settings.member_ai_cap_get')?.permission.roles).toEqual(['admin'])
    expect(tools.find((t) => t.name === 'settings.my_ai_usage')?.auditClass).toBe('read')
  })
})

describe('settings.member_ai_cap_set / _get', () => {
  it('an admin sets the cap (after the approval), reads it back, and clears it; each change is audited', async () => {
    const fx = makeRegistry()
    expect(await fx.registry.execute('settings.member_ai_cap_get', {}, admin)).toEqual({ capUsd: null })

    expect(await approvedRun(fx, 'settings.member_ai_cap_set', { cap_usd: 0.5 }, admin)).toEqual({ capUsd: 0.5 })
    expect(await fx.registry.execute('settings.member_ai_cap_get', {}, admin)).toEqual({ capUsd: 0.5 })

    expect(await approvedRun(fx, 'settings.member_ai_cap_set', { cap_usd: null }, admin)).toEqual({ capUsd: null })
    expect(fx.sets).toEqual([
      { value: 0.5, actor: 'u-admin' },
      { value: null, actor: 'u-admin' },
    ])
    const audited = fx.events.events
      .filter((e) => e.type === 'tool.executed')
      .map((e) => e.payload as { tool: string; ok: boolean; activity?: string; auditClass: string })
      .filter((p) => p.tool === 'settings.member_ai_cap_set' && p.ok)
    expect(audited.map((p) => [p.auditClass, p.activity])).toEqual([
      ['mutate', 'Set the daily AI cap per member to $0.50'],
      ['mutate', 'Removed the daily AI cap per member'],
    ])
  })

  it('a member can neither read nor set the cap, not even through the brain', async () => {
    const fx = makeRegistry()
    for (const ctx of [member, brainAsMember]) {
      await expect(fx.registry.execute('settings.member_ai_cap_get', {}, ctx)).rejects.toMatchObject({
        code: 'permission_denied',
      })
      await expect(
        fx.registry.execute('settings.member_ai_cap_set', { cap_usd: 100 }, ctx),
      ).rejects.toMatchObject({ code: 'permission_denied' })
    }
    expect(fx.sets).toEqual([])
  })

  it('only a positive amount or null: zero, negatives and text are invalid input before any approval', async () => {
    const fx = makeRegistry()
    for (const input of [{ cap_usd: 0 }, { cap_usd: -1 }, { cap_usd: '1' }, {}, { cap_usd: Number.POSITIVE_INFINITY }]) {
      await expect(fx.registry.execute('settings.member_ai_cap_set', input, admin)).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    expect(await fx.approvals.listPending()).toHaveLength(0)
  })
})

describe('settings.my_ai_usage', () => {
  it('a member reads their own usage today against the cap — never anyone else’s', async () => {
    const fx = makeRegistry()
    await approvedRun(fx, 'settings.member_ai_cap_set', { cap_usd: 1 }, admin)
    const out = await fx.registry.execute('settings.my_ai_usage', {}, member)
    expect(out).toEqual({
      role: 'member',
      capUsd: 1,
      capApplies: true,
      spentUsd: 0.25,
      remainingUsd: 0.75,
      resetsAt: '2026-11-24T00:00:00.000Z',
    })
    await fx.registry.execute('settings.my_ai_usage', {}, brainAsMember)
    expect(fx.usageCalls).toEqual(['u-mia', 'u-mia'])
  })

  it('takes no user: it always answers for the caller', async () => {
    const fx = makeRegistry()
    await fx.registry.execute('settings.my_ai_usage', { user_id: 'u-admin' }, member).catch(() => undefined)
    expect(fx.usageCalls.every((id) => id === 'u-mia')).toBe(true)
  })

  it('an agent that is no person has no usage of its own to read', async () => {
    const fx = makeRegistry()
    await expect(fx.registry.execute('settings.my_ai_usage', {}, bareAgent)).rejects.toMatchObject({
      code: 'permission_denied',
    })
  })
})
