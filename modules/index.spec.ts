import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/mcp/tools', () => ({
  runCaptureThoughtTool: vi.fn(),
  runRetrieveThoughtsTool: vi.fn(async () => ({ count: 0, results: [] })),
  runListProjectsTool: vi.fn(),
  runGetProjectTimelineTool: vi.fn(),
  runListTextFilesTool: vi.fn(),
  runGetTextFileTool: vi.fn(),
  runSearchTextFilesTool: vi.fn(),
}))

import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { ToolContext } from '$lib/kernel/types'
import { bootstrapKernel, buildKernel, moduleManifests, APPROVAL_REQUIRED_TOOLS } from './index'

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

function makeInMemoryKernel() {
  const activations = new InMemoryActivationStore()
  const eventSink = new InMemoryEventSink()
  const approvalStore = new InMemoryApprovalStore()
  const kernel = buildKernel({ activations, eventSink, approvalStore, vcsCommitter: null })
  return { kernel, activations, eventSink, approvalStore }
}

describe('moduleManifests', () => {
  it('declares the baseline modules (memory, email, website)', () => {
    expect(moduleManifests.map((m) => m.id)).toEqual(['memory', 'email', 'website'])
  })
})

describe('buildKernel (in-memory fakes, no DB)', () => {
  it('registers manifests and tools consistently', () => {
    const { kernel } = makeInMemoryKernel()

    expect(kernel.modules.list().map((m) => m.id)).toEqual(['memory', 'email', 'website'])
    const toolNames = kernel.registry.list().map((t) => t.name)
    expect(toolNames).toContain('memory.retrieve_thoughts')
    expect(toolNames).toContain('email.send_mail')
    expect(toolNames).toContain('website.create_page')
    expect(toolNames.length).toBe(
      moduleManifests.reduce((sum, m) => sum + m.tools.length, 0),
    )
    for (const tool of kernel.registry.list()) {
      expect(tool.module).toBe(tool.name.slice(0, tool.name.indexOf('.')))
    }
  })

  it('gates execution on module activation (fail closed)', async () => {
    const { kernel, activations } = makeInMemoryKernel()

    await expect(
      kernel.registry.execute('memory.retrieve_thoughts', { top_k: 1 }, ctx),
    ).rejects.toMatchObject({ code: 'module_inactive' })
    expect(kernel.registry.list().length).toBeGreaterThan(0)

    await activations.set('memory', true)
    await expect(
      kernel.registry.execute('memory.retrieve_thoughts', { top_k: 1 }, ctx),
    ).resolves.toEqual({ count: 0, results: [] })
  })

  it('wires StaticApprovalPolicy({email.send_mail}); the kernel gate stops the external send_mail at approval', async () => {
    // Orchestrator decision (2026-09-07): the approval gate fires for every
    // non-read tool, so the external send_mail halts as approval_required and
    // the handler never runs until an owner approves the pending request.
    expect([...APPROVAL_REQUIRED_TOOLS]).toEqual(['email.send_mail'])
    const { kernel, approvalStore } = makeInMemoryKernel()
    await kernel.activations.set('email', true)

    const input = { to: 'a@b.co', subject: 's', html: 'h', text: 't' }
    await expect(kernel.registry.execute('email.send_mail', input, ctx)).rejects.toMatchObject({
      code: 'approval_required',
    })
    const pending = await approvalStore.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ toolName: 'email.send_mail', status: 'pending' })
  })

  it('runs mutate email tools through the full pipeline (fail loud at the owlery boundary)', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('email', true)

    const add = kernel.registry.get('email.add_contact')
    expect(add?.auditClass).toBe('mutate')
    await expect(
      kernel.registry.execute('email.add_contact', { email: 'a@b.co' }, ctx),
    ).rejects.toThrow(/not configured/)
    expect(kernel.eventSink.events.at(-1)?.payload).toMatchObject({
      tool: 'email.add_contact',
      auditClass: 'mutate',
      ok: false,
    })
  })

  it('emits audit events through the injected sink', async () => {
    const { kernel, eventSink, activations } = makeInMemoryKernel()
    await activations.set('memory', true)
    await kernel.registry.execute('memory.retrieve_thoughts', { top_k: 1 }, ctx)
    expect(eventSink.events).toHaveLength(1)
    expect(eventSink.events[0]).toMatchObject({
      type: 'tool.executed',
      principalId: 'principal-1',
      payload: { tool: 'memory.retrieve_thoughts', ok: true },
    })
  })
})

describe('bootstrapKernel singleton', () => {
  it('returns the same instance on repeated calls', () => {
    const first = bootstrapKernel({ vcsCommitter: null })
    const second = bootstrapKernel()
    expect(second).toBe(first)
    expect(second.modules.get('email')).toBeDefined()
  })
})
