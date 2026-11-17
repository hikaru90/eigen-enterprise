import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import { KernelRegistry } from './registry'
import {
  createSettingsTools,
  KERNEL_SETTINGS_TOOL_NAMES,
  type SettingChange,
  type SettingsPort,
  type SettingsView,
} from './settings-tools'

const agent: ToolContext = {
  principal: { id: 'orchestrator', kind: 'agent', roles: ['admin', 'agent'] },
  requestId: 'r1',
  actingUserId: 'u-owner',
}

function view(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    company: { name: 'Kindred Digital Labs', hasLogo: false },
    ai: {
      activeProvider: 'openrouter',
      billing: 'byok',
      providers: [
        {
          provider: 'openrouter',
          configured: true,
          authType: 'api_key',
          modelChat: 'anthropic/claude-x',
          modelEmbedding: null,
          ruleChat: null,
          ruleEmbedding: null,
        },
      ],
    },
    ...overrides,
  }
}

function makePort() {
  const applied: Array<{ change: SettingChange; actor: string }> = []
  const modelCalls: string[] = []
  let current = view()
  const port: SettingsPort = {
    modelFor: async (identity) => {
      modelCalls.push(identity)
      return {
        provider: 'openrouter',
        model: 'anthropic/claude-x',
        routingRuleId: null,
        billing: 'byok',
        gatewayHost: 'openrouter.ai',
        // A careless port leaking a key must never reach the model.
        apiKey: 'sk-secret',
      } as never
    },
    person: async (id) => ({ id, name: 'Ada Owner', email: 'ada@example.com', role: 'owner' }),
    read: async () => ({ ...current, ai: { ...current.ai, apiKey: 'sk-secret' } }) as never,
    apply: async (change, actor) => {
      applied.push({ change, actor })
      if (change.setting === 'company_name') current = view({ company: { name: change.value, hasLogo: false } })
    },
  }
  return { port, applied, modelCalls }
}

function makeRegistry(mode: 'ask' | 'reasonable' | 'allow_all' = 'allow_all') {
  const approvals = new InMemoryApprovalStore()
  const approvalMode = new InMemoryApprovalModeStore(mode)
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), approvalMode),
    approvalStore: approvals,
  })
  const fx = makePort()
  for (const tool of createSettingsTools({ port: fx.port, approvalMode })) registry.register(tool)
  return { registry, approvals, ...fx }
}

describe('settings tools surface', () => {
  it('is exactly kernel.whoami, settings.get, settings.update', () => {
    const { port } = makePort()
    const tools = createSettingsTools({ port, approvalMode: new InMemoryApprovalModeStore('ask') })
    expect(tools.map((t) => t.name)).toEqual([...KERNEL_SETTINGS_TOOL_NAMES])
    const update = tools.find((t) => t.name === 'settings.update')
    expect(update?.approvalAlways).toBe(true)
    expect(update?.auditClass).toBe('mutate')
    expect(tools.find((t) => t.name === 'settings.get')?.auditClass).toBe('read')
    expect(tools.find((t) => t.name === 'kernel.whoami')?.auditClass).toBe('read')
  })
})

describe('kernel.whoami', () => {
  it('reports the model the gateway resolves for this turn’s person, the company and who is talking — no secrets', async () => {
    const { registry, modelCalls } = makeRegistry()
    const out = (await registry.execute('kernel.whoami', {}, agent)) as Record<string, unknown>
    expect(modelCalls).toEqual(['u-owner'])
    expect(out).toMatchObject({
      you: { principalId: 'orchestrator', kind: 'agent' },
      model: { provider: 'openrouter', model: 'anthropic/claude-x', billing: 'byok' },
      company: { name: 'Kindred Digital Labs' },
      actingUser: { id: 'u-owner', name: 'Ada Owner', role: 'owner' },
    })
    expect(JSON.stringify(out)).not.toContain('sk-secret')
  })

  it('without a person on the turn, resolves under the principal (as the engine does) and names nobody', async () => {
    const { registry, modelCalls } = makeRegistry()
    const out = (await registry.execute(
      'kernel.whoami',
      {},
      { principal: agent.principal, requestId: 'r2' },
    )) as Record<string, unknown>
    expect(modelCalls).toEqual(['orchestrator'])
    expect(out.actingUser).toBeNull()
  })
})

describe('settings.get', () => {
  it('returns the company settings, the approval mode and what can be changed — keys stripped', async () => {
    const { registry } = makeRegistry('reasonable')
    const out = (await registry.execute('settings.get', {}, agent)) as Record<string, unknown>
    expect(out).toMatchObject({
      company: { name: 'Kindred Digital Labs' },
      ai: { activeProvider: 'openrouter' },
      approvals: { mode: 'reasonable' },
    })
    expect((out.updatable as Array<{ setting: string }>).map((u) => u.setting)).toEqual([
      'company_name',
      'ai_active_provider',
      'ai_chat_model',
      'ai_chat_routing_rule',
    ])
    expect(JSON.stringify(out)).not.toContain('sk-secret')
  })
})

describe('settings.update: always behind a person’s approval', () => {
  it('waits even under allow_all; after the owner approves, applies exactly once as the acting person', async () => {
    const { registry, approvals, applied } = makeRegistry('allow_all')
    const input = { setting: 'company_name', value: 'Kindred Labs' }

    const gated = await registry.execute('settings.update', input, agent).catch((e) => e)
    expect(gated).toMatchObject({ code: 'approval_required' })
    expect(applied).toHaveLength(0)

    await approvals.decide(gated.details.approvalId, 'approved', 'u-owner')
    const out = (await registry.execute('settings.update', input, agent)) as SettingsView
    expect(applied).toEqual([{ change: input, actor: 'u-owner' }])
    expect(out.company.name).toBe('Kindred Labs')

    await expect(registry.execute('settings.update', input, agent)).rejects.toMatchObject({
      code: 'approval_required',
    })
    expect(applied).toHaveLength(1)
  })

  it('only the allowlisted settings exist: anything else is invalid input before any approval', async () => {
    const { registry, approvals } = makeRegistry('allow_all')
    for (const input of [
      { setting: 'ai_api_key', value: 'sk-new' },
      { setting: 'approval_mode', value: 'allow_all' },
      { setting: 'company_name' },
    ]) {
      await expect(registry.execute('settings.update', input, agent)).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    expect(await approvals.listPending()).toHaveLength(0)
  })
})
