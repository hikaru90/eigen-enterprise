import type { AiUsageOverview, AiUsageRow } from '../ai-usage/overview'
import type { ToolContext } from './types'
import { describe, expect, it } from 'vitest'
import { createAiUsageTools, KERNEL_AI_USAGE_TOOL_NAMES, type AiUsagePort } from './ai-usage-tools'
import { InMemoryApprovalModeStore, InMemoryApprovalStore, ModeAwareApprovalPolicy } from './approvals'
import { InMemoryEventSink } from './events'
import { KernelRegistry } from './registry'

const ctx = (id: string, roles: ('admin' | 'member')[]): ToolContext => ({
  principal: { id, kind: 'human', roles },
  requestId: 'req-1',
})
const admin = ctx('u-admin', ['admin', 'member'])
const member = ctx('u-mia', ['member'])

const ROW: AiUsageRow = {
  userId: 'u-mia',
  name: 'Mia',
  kind: 'person',
  task: 'brain.retrieval_rerank',
  model: 'm/one',
  day: '2026-11-20',
  costUsd: 0.25,
  calls: 1,
  promptTokens: 10,
  completionTokens: 2,
  cachedTokens: 0,
}

function makeRegistry() {
  const reads: { from: string | null; to: string | null }[] = []
  const port: AiUsagePort = {
    rows: async (period) => {
      reads.push(period)
      return [ROW]
    },
  }
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(), new InMemoryApprovalModeStore('ask')),
    approvalStore: new InMemoryApprovalStore(),
  })
  for (const tool of createAiUsageTools({ port })) registry.register(tool)
  return { registry, reads }
}

describe('settings.ai_usage_overview', () => {
  it('is one read tool for the owner and admins', () => {
    const tools = createAiUsageTools({ port: { rows: async () => [] } })
    expect(tools.map((t) => t.name)).toEqual([...KERNEL_AI_USAGE_TOOL_NAMES])
    expect(KERNEL_AI_USAGE_TOOL_NAMES).toEqual(['settings.ai_usage_overview'])
    expect(tools[0]).toMatchObject({ auditClass: 'read', permission: { roles: ['admin'] } })
  })

  it('answers an admin without an approval, for the period asked (UTC dates) or all of it', async () => {
    const { registry, reads } = makeRegistry()
    const all = (await registry.execute('settings.ai_usage_overview', {}, admin)) as AiUsageOverview
    expect(all.totals).toMatchObject({ costUsd: 0.25, calls: 1 })
    expect(all.people).toEqual([expect.objectContaining({ name: 'Mia', kind: 'person' })])
    const some = (await registry.execute('settings.ai_usage_overview', { from: '2026-11-01', to: '2026-11-27' }, admin)) as AiUsageOverview
    expect(some).toMatchObject({ from: '2026-11-01', to: '2026-11-27' })
    expect(reads).toEqual([
      { from: null, to: null },
      { from: '2026-11-01', to: '2026-11-27' },
    ])
  })

  it('refuses a member before reading anything', async () => {
    const { registry, reads } = makeRegistry()
    await expect(registry.execute('settings.ai_usage_overview', {}, member)).rejects.toMatchObject({ code: 'permission_denied' })
    expect(reads).toEqual([])
  })

  it('refuses a date that is none, and a period that ends before it starts', async () => {
    const { registry, reads } = makeRegistry()
    for (const input of [{ from: 'yesterday' }, { from: '2026-02-30' }, { from: '2026-11-27', to: '2026-11-01' }, { days: 7 }]) {
      await expect(registry.execute('settings.ai_usage_overview', input, admin)).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(reads).toEqual([])
  })
})
