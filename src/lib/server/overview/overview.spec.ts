import { describe, expect, it, vi } from 'vitest'
import type { ModuleManifest } from '$lib/kernel/modules'
import type { ToolDescriptor } from '$lib/kernel/types'
import {
  buildOverview,
  owleryResultSource,
  websiteResultSource,
  type OverviewDeps,
  type OverviewRegistry,
} from './overview'

const manifest = (id: string, name: string, description: string): ModuleManifest => ({
  id,
  name,
  version: '0.1.0',
  description,
  tools: [],
  permissions: { roles: ['admin'] },
})

const ctx = { principal: { id: 'u1', kind: 'human' as const, roles: ['admin'] }, requestId: 'r1' }

function registry(tools: Record<string, { summary: string; output?: unknown }>): OverviewRegistry {
  return {
    get: (name) =>
      tools[name] ? ({ name, module: name.split('.')[0], summary: tools[name].summary } as ToolDescriptor) : undefined,
    execute: vi.fn(async (name: string) => {
      if (!tools[name]) throw new Error(`unknown tool ${name}`)
      return tools[name].output
    }),
  }
}

function deps(over: Partial<OverviewDeps>): OverviewDeps {
  return {
    manifests: [],
    activations: new Map(),
    registry: registry({}),
    ctx,
    canReadResults: true,
    resultSources: {},
    recentToolEvents: async () => [],
    pendingApprovals: async () => [],
    ...over,
  }
}

describe('buildOverview', () => {
  it('lists active and inactive modules with their manifest description', async () => {
    const out = await buildOverview(
      deps({
        manifests: [manifest('website', 'Website', 'The site.'), manifest('repo', 'Repo', 'Code.')],
        activations: new Map([['website', true]]),
      }),
    )
    expect(out.modules).toEqual([
      { id: 'website', name: 'Website', description: 'The site.', active: true, results: [], counts: [], note: null },
      { id: 'repo', name: 'Repo', description: 'Code.', active: false, results: [], counts: [], note: null },
    ])
  })

  it('maps website.site_info into results, with the journey status', async () => {
    const reg = registry({
      'website.site_info': {
        summary: 'Site info',
        output: {
          url: 'http://localhost:5173/site',
          pages: [
            { slug: 'home', title: 'Home', status: 'published', url: 'http://localhost:5173/site/home' },
            { slug: 'about', title: 'About', status: 'draft', url: 'http://localhost:5173/site/about' },
          ],
        },
      },
    })
    const out = await buildOverview(
      deps({
        manifests: [manifest('website', 'Website', 'The site.')],
        activations: new Map([['website', true]]),
        registry: reg,
        resultSources: { website: websiteResultSource(async () => 'in_progress') },
      }),
    )
    expect(reg.execute).toHaveBeenCalledWith('website.site_info', {}, ctx)
    expect(out.modules[0].results).toEqual([
      { label: 'Founding journey', detail: 'In progress', href: null },
      { label: 'Site', detail: null, href: 'http://localhost:5173/site' },
      { label: 'Home', detail: 'Published', href: 'http://localhost:5173/site/home' },
      { label: 'About', detail: 'Draft', href: 'http://localhost:5173/site/about' },
    ])
    expect(out.modules[0].counts).toEqual([
      { label: 'Published', value: 1 },
      { label: 'Drafts', value: 1 },
    ])
    expect(out.modules[0].note).toBeNull()
  })

  it('says the preview link is not available only when website.site_info is missing', async () => {
    const out = await buildOverview(
      deps({
        manifests: [manifest('website', 'Website', 'The site.')],
        activations: new Map([['website', true]]),
        resultSources: { website: websiteResultSource(async () => 'not_started') },
      }),
    )
    expect(out.modules[0].note).toBe('Preview link not available yet')
    expect(out.modules[0].results).toEqual([{ label: 'Founding journey', detail: 'Not started', href: null }])
  })

  it('shows email sender and setup state, never secrets', async () => {
    const reg = registry({
      'owlery.status': {
        summary: 'Email status',
        output: {
          configured: true,
          region: 'eu-central-1',
          sender: 'hello@kindred.test',
          senderVerified: true,
          sandbox: false,
          secretAccessKey: 'SHOULD-NEVER-SHOW',
          accessKeyId: 'AKIA-NEVER',
        },
      },
    })
    const out = await buildOverview(
      deps({
        manifests: [manifest('owlery', 'Email', 'Mail.')],
        activations: new Map([['owlery', true]]),
        registry: reg,
        resultSources: { owlery: owleryResultSource },
      }),
    )
    expect(out.modules[0].results).toEqual([{ label: 'hello@kindred.test', detail: 'Set up', href: null }])
    expect(JSON.stringify(out)).not.toMatch(/NEVER/)
  })

  it('shows unconfigured email plainly', async () => {
    const out = await buildOverview(
      deps({
        manifests: [manifest('owlery', 'Email', 'Mail.')],
        activations: new Map([['owlery', true]]),
        registry: registry({ 'owlery.status': { summary: 's', output: { configured: false } } }),
        resultSources: { owlery: owleryResultSource },
      }),
    )
    expect(out.modules[0].results).toEqual([{ label: 'Not set up', detail: null, href: null }])
  })

  it('does not read results for inactive modules or non-owners', async () => {
    const source = vi.fn()
    const inactive = await buildOverview(
      deps({ manifests: [manifest('owlery', 'Email', 'Mail.')], resultSources: { owlery: source } }),
    )
    const member = await buildOverview(
      deps({
        manifests: [manifest('owlery', 'Email', 'Mail.')],
        activations: new Map([['owlery', true]]),
        canReadResults: false,
        resultSources: { owlery: source },
      }),
    )
    expect(source).not.toHaveBeenCalled()
    expect(inactive.modules[0].note).toBeNull()
    expect(member.modules[0].note).toBe('Only the owner can see these results.')
  })

  it('shows the declared activity sentence, failed calls keep ok:false', async () => {
    const out = await buildOverview(
      deps({
        manifests: [manifest('website', 'Website', 'The site.')],
        registry: registry({ 'website.publish_page': { summary: 'Flip the visibility of one website content object.' } }),
        recentToolEvents: async () => [
          {
            ts: '2026-10-20T10:00:00.000Z',
            payload: { tool: 'website.publish_page', ok: true, activity: 'Published the About page' },
          },
          {
            ts: '2026-10-20T09:30:00.000Z',
            payload: { tool: 'website.publish_page', ok: false, error: 'x', activity: 'Published the page “ghost”' },
          },
        ],
      }),
    )
    expect(out.actions).toEqual([
      { at: '2026-10-20T10:00:00.000Z', text: 'Published the About page', ok: true },
      { at: '2026-10-20T09:30:00.000Z', text: 'Published the page “ghost”', ok: false },
    ])
  })

  it('legacy events without activity read "<Module name>: <tool name>", never the developer summary', async () => {
    const out = await buildOverview(
      deps({
        manifests: [manifest('owlery', 'Email', 'Mail.')],
        registry: registry({ 'owlery.send_mail': { summary: "Send one email from the company's sender address." } }),
        recentToolEvents: async () => [
          { ts: '2026-10-20T10:00:00.000Z', payload: { tool: 'owlery.send_mail', ok: true } },
          { ts: '2026-10-20T09:00:00.000Z', payload: { tool: 'gone.tool', ok: false } },
        ],
      }),
    )
    expect(out.actions).toEqual([
      { at: '2026-10-20T10:00:00.000Z', text: 'Email: owlery.send_mail', ok: true },
      { at: '2026-10-20T09:00:00.000Z', text: 'gone.tool', ok: false },
    ])
  })

  it('pending approvals use the declared plain approval copy', async () => {
    const out = await buildOverview(
      deps({
        registry: registry({ 'website.publish_page': { summary: 'Flip the visibility.' } }),
        pendingApprovals: async () => [{ id: 'a1', toolName: 'website.publish_page' }],
      }),
    )
    expect(out.approvals).toEqual([{ id: 'a1', text: 'Publish a page of your website' }])
  })

  it('fails loud on a malformed audit payload', async () => {
    await expect(
      buildOverview(deps({ recentToolEvents: async () => [{ ts: 't', payload: { nope: 1 } }] })),
    ).rejects.toThrow(/malformed/)
  })
})
