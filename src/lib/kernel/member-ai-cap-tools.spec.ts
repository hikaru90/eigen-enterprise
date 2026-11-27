import type { AiBilling } from '../ai-usage/billing'
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

const REPLY_WITH_COST = '0b6f3c1e-8f55-4c2a-9d0e-6a1b2c3d4e5f'
const REPLY_OLD = '1c7f4d2f-9a66-4d3b-8e1f-7b2c3d4e5f60'
const NOT_MINE = '2d8a5e3a-ab77-4e4c-9f2a-8c3d4e5f6071'

function makePort(billing: AiBilling | null = null) {
  const sets: Array<{ value: number | null; actor: string }> = []
  let cap: number | null = null
  const usageCalls: string[] = []
  const replyCalls: string[] = []
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
    // u-mia's replies: one with a recorded cost, one from before costs were kept.
    replyCost: async (userId, messageId) => {
      replyCalls.push(`${userId}:${messageId}`)
      if (userId !== 'u-mia') return null
      if (messageId === REPLY_WITH_COST) return { usage: { costUsd: 0.0042, tokens: 1234, modelCalls: 2 } }
      if (messageId === REPLY_OLD) return { usage: null }
      return null
    },
    billing: async () => billing,
    eigenInferenceUsdToday: async (userId) => {
      usageCalls.push(`eigenInference:${userId}`)
      return 0.2
    },
  }
  return { port, sets, usageCalls, replyCalls }
}

function makeRegistry(mode: 'ask' | 'reasonable' | 'allow_all' = 'allow_all', billing: AiBilling | null = null) {
  const approvals = new InMemoryApprovalStore()
  const approvalMode = new InMemoryApprovalModeStore(mode)
  const events = new InMemoryEventSink()
  const registry = new KernelRegistry({
    eventSink: events,
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), approvalMode),
    approvalStore: approvals,
  })
  const fx = makePort(billing)
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

  it('hosted with eigenInference: also what your eigenInference calls today are invoiced, in EUR with the rate and its day', async () => {
    const billing = { currency: 'EUR' as const, markup: 1.5, usdToEur: 0.9, rateDay: '2026-11-27' }
    const fx = makeRegistry('allow_all', billing)
    expect(await fx.registry.execute('settings.my_ai_usage', {}, member)).toMatchObject({
      spentUsd: 0.25,
      invoiced: { providerUsd: 0.2, invoicedEur: 0.27, billing },
    })
    expect(fx.usageCalls).toEqual(['u-mia', 'eigenInference:u-mia'])
  })

  it('with reply_message_id it also says what that reply of yours cost (null when none was recorded)', async () => {
    const fx = makeRegistry()
    expect(await fx.registry.execute('settings.my_ai_usage', { reply_message_id: REPLY_WITH_COST }, member)).toMatchObject({
      spentUsd: 0.25,
      reply: { costUsd: 0.0042, tokens: 1234, modelCalls: 2 },
    })
    expect(await fx.registry.execute('settings.my_ai_usage', { reply_message_id: REPLY_OLD }, brainAsMember)).toMatchObject({
      reply: null,
    })
    await expect(
      fx.registry.execute('settings.my_ai_usage', { reply_message_id: NOT_MINE }, member),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      fx.registry.execute('settings.my_ai_usage', { reply_message_id: 'not-an-id' }, member),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fx.replyCalls.every((call) => call.startsWith('u-mia:'))).toBe(true)
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
