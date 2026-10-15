import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { KernelError } from '$lib/kernel/errors'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { VcsCommitter } from '$lib/kernel/vcs'
import { ROADMAP_TOOL_NAMES, roadmapManifest } from './manifest'
import { InMemoryRoadmapStore } from './store'
import { createRoadmapTools } from './tools'

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

describe('roadmapManifest', () => {
  it('owns the namespaced roadmap tool names', () => {
    expect(roadmapManifest.id).toBe('roadmap')
    expect(roadmapManifest.version).toBe('0.1.0')
    expect(roadmapManifest.tools).toEqual([...ROADMAP_TOOL_NAMES])
    expect(roadmapManifest.tools.every((name) => name.startsWith('roadmap.'))).toBe(true)
    expect(roadmapManifest.permissions).toEqual({ roles: ['admin', 'agent'] })
  })
})

describe('createRoadmapTools', () => {
  const tools = createRoadmapTools({ store: new InMemoryRoadmapStore() })
  const byName = new Map(tools.map((t) => [t.name, t]))

  it('builds exactly the manifest tools with correct audit classes', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...ROADMAP_TOOL_NAMES].sort())
    expect(byName.get('roadmap.list_items')?.auditClass).toBe('read')
    expect(byName.get('roadmap.add_item')?.auditClass).toBe('mutate')
    expect(byName.get('roadmap.update_item')?.auditClass).toBe('mutate')
    for (const descriptor of tools) {
      expect(descriptor.module).toBe('roadmap')
      expect(descriptor.permission.roles).toEqual(['admin', 'agent'])
    }
  })

  it('validates inputs with zod (title required, status/kind within vocabulary)', () => {
    const add = byName.get('roadmap.add_item')?.inputSchema
    expect(add?.safeParse({ title: 'One-command deploy' }).success).toBe(true)
    expect(add?.safeParse({}).success).toBe(false)
    expect(add?.safeParse({ title: '' }).success).toBe(false)
    expect(
      add?.safeParse({ title: 'A', detail: 'd', status: 'in_progress', kind: 'chore', position: 2 })
        .success,
    ).toBe(true)
    expect(add?.safeParse({ title: 'A', status: 'done' }).success).toBe(false)
    expect(add?.safeParse({ title: 'A', kind: 'wish' }).success).toBe(false)
    expect(add?.safeParse({ title: 'A', position: -1 }).success).toBe(false)

    const update = byName.get('roadmap.update_item')?.inputSchema
    expect(update?.safeParse({ id: 'row-1', title: 'New' }).success).toBe(true)
    expect(update?.safeParse({ id: 'row-1' }).success).toBe(true)
    expect(update?.safeParse({ title: 'New' }).success).toBe(false)
    expect(update?.safeParse({ id: 'row-1', status: 'shipped' }).success).toBe(true)
    expect(update?.safeParse({ id: 'row-1', status: 'archived' }).success).toBe(false)
    expect(update?.safeParse({ id: '', title: 'New' }).success).toBe(false)

    const list = byName.get('roadmap.list_items')?.inputSchema
    expect(list?.safeParse({}).success).toBe(true)
    expect(list?.safeParse({ status: 'planned' }).success).toBe(false)
  })
})

describe('roadmap tools through the kernel registry pipeline', () => {
  function makeRegistry(policyAllow: ReadonlySet<string> = new Set()) {
    const store = new InMemoryRoadmapStore()
    const sink = new InMemoryEventSink()
    const activations = new InMemoryActivationStore()
    const approvals = new InMemoryApprovalStore()
    const commits: string[] = []
    const vcs: VcsCommitter = {
      commit: async (message: string) => {
        commits.push(message)
        return 'deadbeef'
      },
    }
    const registry = new KernelRegistry({
      eventSink: sink,
      activationStore: activations,
      approvalPolicy: new StaticApprovalPolicy(policyAllow),
      approvalStore: approvals,
      vcsCommitter: vcs,
    })
    const descriptors: ToolDescriptor[] = createRoadmapTools({ store })
    for (const descriptor of descriptors) registry.register(descriptor)
    return { store, sink, activations, commits, registry }
  }

  it('add_item runs the full mutate pipeline: store write, audit event, vcs commit', async () => {
    const { registry, store, sink, activations, commits } = makeRegistry()
    await activations.set('roadmap', true)

    const result = await registry.execute(
      'roadmap.add_item',
      { title: 'One-command deploy', detail: 'curl-to-VPS.' },
      ctx,
    )
    expect(result).toMatchObject({
      title: 'One-command deploy',
      detail: 'curl-to-VPS.',
      status: 'planned',
      kind: 'feature',
      shippedAt: null,
    })
    expect((await store.list()).map((item) => item.title)).toEqual(['One-command deploy'])

    const audits = sink.events.filter((e) => e.type === 'tool.executed')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      type: 'tool.executed',
      principalId: 'principal-1',
      payload: { tool: 'roadmap.add_item', auditClass: 'mutate', ok: true },
    })
    expect(commits).toEqual(['tool roadmap.add_item by principal-1'])
  })

  it('update_item is the status machine: shipping stamps shipped_at, unshipping clears it', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('roadmap', true)

    const created = await registry.execute('roadmap.add_item', { title: 'A' }, ctx)
    const id = (created as { id: string }).id

    const shipped = await registry.execute('roadmap.update_item', { id, status: 'shipped' }, ctx)
    expect(shipped).toMatchObject({ status: 'shipped', shippedAt: expect.any(String) })

    const reopened = await registry.execute('roadmap.update_item', { id, status: 'planned' }, ctx)
    expect(reopened).toMatchObject({ status: 'planned', shippedAt: null })
  })

  it('update_item throws loud for an unknown id: no silent no-op, audit ok:false, no vcs commit', async () => {
    const { registry, sink, activations, commits } = makeRegistry()
    await activations.set('roadmap', true)

    await expect(
      registry.execute('roadmap.update_item', { id: 'nope', title: 'x' }, ctx),
    ).rejects.toThrow(/unknown roadmap item: nope/)

    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({ tool: 'roadmap.update_item', ok: false })
    expect(commits).toHaveLength(0)
  })

  it('list_items orders shipped build log first, then work in progress, then planned queue', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('roadmap', true)
    await registry.execute('roadmap.add_item', { title: 'planned b', position: 1 }, ctx)
    await registry.execute(
      'roadmap.add_item',
      { title: 'shipped', status: 'shipped', position: 0 },
      ctx,
    )
    await registry.execute('roadmap.add_item', { title: 'planned a', position: 0 }, ctx)

    await expect(registry.execute('roadmap.list_items', {}, ctx)).resolves.toEqual([
      expect.objectContaining({ title: 'shipped' }),
      expect.objectContaining({ title: 'planned a' }),
      expect.objectContaining({ title: 'planned b' }),
    ])
  })

  it('read tools emit audit but never vcs-commit', async () => {
    const { registry, sink, activations, commits } = makeRegistry()
    await activations.set('roadmap', true)

    await registry.execute('roadmap.list_items', {}, ctx)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({ auditClass: 'read', ok: true })
    expect(commits).toHaveLength(0)
  })

  it('gates on module activation (fail closed) and on principal roles', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('roadmap', false)
    await expect(registry.execute('roadmap.list_items', {}, ctx)).rejects.toMatchObject({
      code: 'module_inactive',
    })

    await activations.set('roadmap', true)
    await expect(
      registry.execute(
        'roadmap.list_items',
        {},
        { ...ctx, principal: { id: 'p2', kind: 'human', roles: ['viewer'] } },
      ),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof KernelError && err.code === 'permission_denied',
    )
  })
})
