import { describe, expect, it } from 'vitest'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { KernelError } from '$lib/kernel/errors'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { VcsCommitter } from '$lib/kernel/vcs'
import { WEBSITE_TOOL_NAMES, websiteManifest } from './manifest'
import { InMemoryWebsiteStore } from './store'
import { createWebsiteTools } from './tools'

const ctx: ToolContext = {
  principal: { id: 'principal-1', kind: 'human', roles: ['admin', 'agent'] },
  requestId: 'req-1',
}

describe('websiteManifest', () => {
  it('owns the namespaced website tool names', () => {
    expect(websiteManifest.id).toBe('website')
    expect(websiteManifest.version).toBe('0.2.0')
    expect(websiteManifest.tools.slice(0, WEBSITE_TOOL_NAMES.length)).toEqual([...WEBSITE_TOOL_NAMES])
    expect([...WEBSITE_TOOL_NAMES].every((name) => name.startsWith('website.'))).toBe(true)
    expect(websiteManifest.toolNamespaces).toEqual(['website', 'substrate', 'github'])
  })
})

describe('createWebsiteTools', () => {
  const tools = createWebsiteTools({ store: new InMemoryWebsiteStore() })
  const byName = new Map(tools.map((t) => [t.name, t]))

  it('builds exactly the manifest tools with correct audit classes', () => {
    expect(tools.map((t) => t.name).sort()).toEqual([...WEBSITE_TOOL_NAMES].sort())
    expect(byName.get('website.create_page')?.auditClass).toBe('mutate')
    expect(byName.get('website.update_page')?.auditClass).toBe('mutate')
    expect(byName.get('website.publish_page')?.auditClass).toBe('mutate')
    expect(byName.get('website.get_page')?.auditClass).toBe('read')
    expect(byName.get('website.list_pages')?.auditClass).toBe('read')
    for (const descriptor of tools) {
      expect(descriptor.module).toBe('website')
      expect(descriptor.permission.roles).toEqual(['admin', 'agent'])
    }
  })

  it('validates inputs with zod (slug/title/body required, kind/visibility enum)', () => {
    const create = byName.get('website.create_page')?.inputSchema
    expect(create?.safeParse({ slug: 'a', title: 't', body: 'b' }).success).toBe(true)
    expect(create?.safeParse({ slug: 'a', title: 't' }).success).toBe(false)
    expect(
      create?.safeParse({ slug: 'a', title: 't', body: 'b', kind: 'doc', visibility: 'public' })
        .success,
    ).toBe(true)
    expect(
      create?.safeParse({ slug: 'a', title: 't', body: 'b', kind: 'brochure' }).success,
    ).toBe(false)

    const publish = byName.get('website.publish_page')?.inputSchema
    expect(publish?.safeParse({ slug: 'a', visibility: 'public' }).success).toBe(true)
    expect(publish?.safeParse({ slug: 'a', visibility: 'draft' }).success).toBe(false)
    expect(publish?.safeParse({ slug: 'a' }).success).toBe(false)

    const update = byName.get('website.update_page')?.inputSchema
    expect(update?.safeParse({ slug: 'a', title: 'new' }).success).toBe(true)
    expect(update?.safeParse({ slug: 'a' }).success).toBe(true)
    expect(update?.safeParse({ title: 'new' }).success).toBe(false)

    const list = byName.get('website.list_pages')?.inputSchema
    expect(list?.safeParse({}).success).toBe(true)
    expect(list?.safeParse({ visibility: 'public' }).success).toBe(true)
    expect(list?.safeParse({ visibility: 'nope' }).success).toBe(false)
  })
})

describe('website tools through the kernel registry pipeline', () => {
  function makeRegistry(policyAllow: ReadonlySet<string> = new Set()) {
    const store = new InMemoryWebsiteStore()
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
    const descriptors: ToolDescriptor[] = createWebsiteTools({ store })
    for (const descriptor of descriptors) registry.register(descriptor)
    return { store, sink, activations, commits, registry }
  }

  it('create_page runs the full mutate pipeline: store write, audit event, vcs commit', async () => {
    const { registry, store, sink, activations, commits } = makeRegistry()
    await activations.set('website', true)

    const result = await registry.execute(
      'website.create_page',
      { slug: 'about', title: 'About', body: '# About' },
      ctx,
    )
    expect(result).toMatchObject({ slug: 'about', title: 'About', visibility: 'private' })
    expect(await store.getPage('about')).not.toBeNull()

    const audits = sink.events.filter((e) => e.type === 'tool.executed')
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      type: 'tool.executed',
      principalId: 'principal-1',
      payload: { tool: 'website.create_page', auditClass: 'mutate', ok: true },
    })
    expect(commits).toEqual(['tool website.create_page by principal-1'])
  })

  it('duplicate slug fails loud through the pipeline: no silent overwrite, audit ok:false, no vcs commit', async () => {
    const { registry, store, sink, activations, commits } = makeRegistry()
    await activations.set('website', true)
    await registry.execute('website.create_page', { slug: 'a', title: 'First', body: 'x' }, ctx)
    sink.events.length = 0

    await expect(
      registry.execute('website.create_page', { slug: 'a', title: 'Second', body: 'y' }, ctx),
    ).rejects.toThrow(/duplicate website slug: a/)

    const page = await store.getPage('a')
    expect(page?.title).toBe('First')
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({ tool: 'website.create_page', ok: false })
    // the only commit is from the first, successful create — the failed one commits nothing
    expect(commits).toEqual(['tool website.create_page by principal-1'])
  })

  it('update_page throws loud for an unknown slug', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('website', true)

    await expect(
      registry.execute('website.update_page', { slug: 'nope', title: 'x' }, ctx),
    ).rejects.toThrow(/unknown website page: nope/)
  })

  it('publish_page is the visibility flip and get_page reflects it', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('website', true)
    await registry.execute('website.create_page', { slug: 'a', title: 'A', body: 'x' }, ctx)

    await expect(
      registry.execute('website.publish_page', { slug: 'a', visibility: 'public' }, ctx),
    ).resolves.toMatchObject({ visibility: 'public' })
    await expect(
      registry.execute('website.get_page', { slug: 'a' }, ctx),
    ).resolves.toMatchObject({ visibility: 'public', slug: 'a' })

    await registry.execute('website.publish_page', { slug: 'a', visibility: 'private' }, ctx)
    await expect(registry.execute('website.get_page', { slug: 'a' }, ctx)).resolves.toMatchObject({
      visibility: 'private',
    })
  })

  it('list_pages filters by kind and visibility', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('website', true)
    await registry.execute(
      'website.create_page',
      { slug: 'home', title: 'H', body: 'x', visibility: 'public' },
      ctx,
    )
    await registry.execute(
      'website.create_page',
      { slug: 'handbook', title: 'HB', body: 'x', kind: 'doc' },
      ctx,
    )

    await expect(registry.execute('website.list_pages', {}, ctx)).resolves.toHaveLength(2)
    await expect(
      registry.execute('website.list_pages', { visibility: 'public' }, ctx),
    ).resolves.toHaveLength(1)
    await expect(registry.execute('website.list_pages', { kind: 'doc' }, ctx)).resolves.toMatchObject(
      [expect.objectContaining({ slug: 'handbook' })],
    )
  })

  it('read tools emit audit but never vcs-commit', async () => {
    const { registry, sink, activations, commits } = makeRegistry()
    await activations.set('website', true)

    await registry.execute('website.list_pages', {}, ctx)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0].payload).toMatchObject({ auditClass: 'read', ok: true })
    expect(commits).toHaveLength(0)
  })

  it('gates on module activation (fail closed) and on principal roles', async () => {
    const { registry, activations } = makeRegistry()
    await activations.set('website', false)
    await expect(
      registry.execute('website.get_page', { slug: 'a' }, ctx),
    ).rejects.toMatchObject({ code: 'module_inactive' })

    await activations.set('website', true)
    await expect(
      registry.execute(
        'website.get_page',
        { slug: 'a' },
        { ...ctx, principal: { id: 'p2', kind: 'human', roles: ['viewer'] } },
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof KernelError && err.code === 'permission_denied')
  })
})
