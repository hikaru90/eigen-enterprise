import { describe, expect, it, vi } from 'vitest'

// Hermetic: private-env-dependent failure paths must not depend on the
// developer machine's .env (placeholders would turn fail-loud assertions
// into fetch-against-garbage).
vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

vi.mock('$lib/server/mcp/tools', () => ({
  runCaptureThoughtTool: vi.fn(),
  runRetrieveThoughtsTool: vi.fn(async () => ({ count: 0, results: [] })),
  runListProjectsTool: vi.fn(),
  runGetProjectTimelineTool: vi.fn(),
  runListTextFilesTool: vi.fn(),
  runGetTextFileTool: vi.fn(),
  runSearchTextFilesTool: vi.fn(),
}))

// Hermetic brand store for the approval-flow spec: buildKernel wires the
// default (DB-backed) brand store; the visual_set_activate gate test below
// swaps in one shared in-memory store so no DATABASE_URL is needed.
vi.mock('./brand/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./brand/store')>()
  const singleton = new actual.InMemoryBrandStore()
  return { ...actual, defaultBrandStore: () => singleton }
})

import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import type { Brain } from '$lib/kernel/gateway'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { ToolContext } from '$lib/kernel/types'
import type { AppDatabase } from '$lib/server/db/context'
import { REQUIRED_VISUAL_ROLES } from './brand/store'
import {
  APPROVAL_REQUIRED_TOOLS,
  bootstrapChatGateway,
  bootstrapKernel,
  buildKernel,
  moduleManifests,
} from './index'
import { bootstrapOrchestrator } from './orchestrator/bootstrap'
import { OrchestratorBrain } from './orchestrator/brain'

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
  it('declares the baseline modules (memory, email, website, dev-agent, brand, repo, roadmap, substrate, github)', () => {
    expect(moduleManifests.map((m) => m.id)).toEqual([
      'memory',
      'email',
      'website',
      'dev-agent',
      'brand',
      'repo',
      'roadmap',
      'substrate',
      'github',
    ])
  })
})

describe('buildKernel (in-memory fakes, no DB)', () => {
  it('registers manifests and tools consistently', () => {
    const { kernel } = makeInMemoryKernel()

    expect(kernel.modules.list().map((m) => m.id)).toEqual([
      'memory',
      'email',
      'website',
      'dev-agent',
      'brand',
      'repo',
      'roadmap',
      'substrate',
      'github',
    ])
    const toolNames = kernel.registry.list().map((t) => t.name)
    expect(toolNames).toContain('memory.retrieve_thoughts')
    expect(toolNames).toContain('email.send_mail')
    expect(toolNames).toContain('website.create_page')
    expect(toolNames).toContain('dev-agent.dispatch')
    expect(toolNames).toContain('dev-agent.merge')
    expect(toolNames).toContain('brand.set_create')
    expect(toolNames).toContain('repo.worktree_create')
    expect(toolNames).toContain('repo.merge')
    expect(toolNames).toContain('roadmap.list_items')
    expect(toolNames).toContain('roadmap.add_item')
    expect(toolNames).toContain('roadmap.update_item')
    expect(toolNames).toContain('substrate.status')
    expect(toolNames).toContain('github.app_create')
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

  it('wires StaticApprovalPolicy({email.send_mail, brand.set_activate, brand.visual_set_activate, website.publish_page, repo.merge}); the kernel gate stops external sends and brand go-lives at approval', async () => {
    // Orchestrator decision (2026-09-07): the approval gate fires for every
    // non-read tool, so the external send_mail halts as approval_required and
    // the handler never runs until an owner approves the pending request.
    // Phase-2c (G8/D5): brand.set_activate joins the set — activation is a
    // strategic brand decision owned by a human approver.
    // Phase-2d M5 (V9): brand.visual_set_activate gates the visual go-live —
    // once approved, the set applies globally to all user-facing surfaces.
    // Website founding journey: publishing is public, so the journey's
    // website.publish_page artifacts gate here too.
    // Phase-3 M2: repo.merge gates the agent's repo hands — landing agent work
    // on the instance repo is an owner decision made in chat.
    // Phase-3 one-agent: module lifecycle levers gate too — the agent calls
    // kernel.module_activate/deactivate, the owner's conversational yes decides.
    expect([...APPROVAL_REQUIRED_TOOLS].sort()).toEqual([
      'brand.set_activate',
      'brand.visual_set_activate',
      'email.send_mail',
      'kernel.module_activate',
      'kernel.module_deactivate',
      'repo.merge',
      'website.publish_page',
    ])
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

  it('brand.visual_set_activate is approval-gated: no execution before the owner decision, activation after it (phase-2d M5/V9)', async () => {
    const { kernel, approvalStore } = makeInMemoryKernel()
    await kernel.activations.set('brand', true)

    // Draft a complete visual set through the M4 wizard tool; the gate under
    // test here is activation (M5).
    const draft = (await kernel.registry.execute(
      'brand.visual_set_create',
      {
        name: 'Kindred go-live',
        pickedIds: ['5a000000-0000-4000-8000-00000000000a'],
        cssVars: Object.fromEntries(
          REQUIRED_VISUAL_ROLES.map((role) => [
            `--${role}`,
            role === 'radius' ? '0.25rem' : '#111111',
          ]),
        ),
      },
      ctx,
    )) as { id: string }

    // First activation attempt halts at the approval gate; the store is untouched.
    await expect(
      kernel.registry.execute('brand.visual_set_activate', { setId: draft.id }, ctx),
    ).rejects.toMatchObject({ code: 'approval_required' })
    const pending = await approvalStore.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ toolName: 'brand.visual_set_activate', status: 'pending' })

    // A retry while still pending halts again (no second request, no execution).
    await expect(
      kernel.registry.execute('brand.visual_set_activate', { setId: draft.id }, ctx),
    ).rejects.toMatchObject({ code: 'approval_required' })
    expect(await approvalStore.listPending()).toHaveLength(1)

    // The owner approves; the SAME input now executes and activates.
    await approvalStore.decide(pending[0]!.id, 'approved', 'owner-1')
    const activated = (await kernel.registry.execute(
      'brand.visual_set_activate',
      { setId: draft.id },
      ctx,
    )) as { status: string }
    expect(activated.status).toBe('active')
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

describe('bootstrapChatGateway (composition root — gateway boot stage)', () => {
  const stubBrain: Brain = { respond: async () => 'ok' }

  it('returns null while the module is inactive and needs no bot token', async () => {
    const { kernel } = makeInMemoryKernel()

    const boot = await bootstrapChatGateway(kernel, stubBrain, { env: {} })

    expect(boot).toBeNull()
    // Gateway surface is NOT registered while the module is inactive.
    expect(kernel.registry.get('chat-gateway.status')).toBeUndefined()
    expect(kernel.registry.get('chat-gateway.allowlist_add')).toBeUndefined()
    expect(kernel.modules.get('chat-gateway')).toBeUndefined()
  })

  it('registers the gateway manifest + tools through the kernel contract validation when active', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('chat-gateway', true)

    const boot = await bootstrapChatGateway(kernel, stubBrain, {
      env: { TELEGRAM_BOT_TOKEN: 'test-token' },
      db: {} as AppDatabase,
    })

    expect(boot).not.toBeNull()
    expect(kernel.modules.get('chat-gateway')).toBeDefined()
    for (const name of [
      'chat-gateway.status',
      'chat-gateway.allowlist_add',
      'chat-gateway.allowlist_remove',
      'chat-gateway.allowlist_list',
    ]) {
      expect(kernel.registry.get(name)).toBeDefined()
    }
    expect(boot!.gateway).not.toBeNull()
    expect(boot!.allowlist).not.toBeNull()
    expect(boot!.sessions).not.toBeNull()
  })

  it('fails loud when the module is active but TELEGRAM_BOT_TOKEN is missing', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('chat-gateway', true)

    await expect(
      bootstrapChatGateway(kernel, stubBrain, { env: {}, db: {} as AppDatabase }),
    ).rejects.toThrow(/TELEGRAM_BOT_TOKEN/)
  })

  it('composes the full Phase-0 path: brain → gateway stage → loop (fail-closed surface)', async () => {
    const { kernel, activations } = makeInMemoryKernel()
    await activations.set('chat-gateway', true)
    await activations.set('memory', true)

    const boot = await bootstrapOrchestrator(
      kernel,
      (brain) =>
        bootstrapChatGateway(kernel, brain, {
          env: { TELEGRAM_BOT_TOKEN: 'test-token' },
          db: {} as AppDatabase,
        }),
      { startLoop: false },
    )

    expect(boot.status()).toEqual({ chatGateway: 'active', loopRunning: false })
    expect(boot.brain).toBeInstanceOf(OrchestratorBrain)
    expect(boot.gateway).not.toBeNull()
    expect(boot.loop).not.toBeNull()

    // The brain offers memory tools (memory module active) and never gateway
    // owner tools — the gateway surface is owner-only by design.
    const brain = boot.brain as unknown as { offeredTools(): Promise<Array<{ name: string }>> }
    const offered = await brain.offeredTools()
    expect(offered.map((t) => t.name)).toContain('memory.retrieve_thoughts')
    expect(offered.map((t) => t.name)).not.toContain('chat-gateway.allowlist_add')

    await boot.loop!.stop()
  })
})
