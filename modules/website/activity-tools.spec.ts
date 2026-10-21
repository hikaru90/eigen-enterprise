import { describe, expect, it } from 'vitest'
import type { KernelEvent } from '$lib/kernel/events'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { SubstrateError, SubstrateUnavailableError, type EeEvent } from '$lib/server/ee/client'
import { createActivityTools } from './activity-tools'
import { FakeEe } from './apps/testing'
import { WEBSITE_ACTIVITY_TOOL } from './manifest'

/**
 * website.activity (plan/phase-website-apps-ux.md W5): the Website module
 * page's recent activity — ee's server journal mapped by event type, plus the
 * kernel's tool audit rows for this module's namespaces. Kind and sentence
 * come from structural identifiers only (ee event type, kernel tool id, the
 * audit's stored activity sentence) — never from parsing message text.
 */

const human: ToolContext = {
  principal: { id: 'u1', kind: 'human', roles: ['admin'] },
  requestId: 'r',
}

const T0 = '2026-10-20T10:00:00Z'
const T1 = '2026-10-20T10:05:00Z'
const T2 = '2026-10-20T10:10:00Z'

function eeEvent(
  type: string,
  workload: string | null,
  time: string,
  message = 'ee says',
): EeEvent {
  return { id: type + time, time, type, workload, message, data: {} }
}

function toolEvent(over: {
  tool: string
  ts?: string
  ok?: boolean
  auditClass?: string
  activity?: string
  principalId?: string
}): KernelEvent {
  return {
    id: 'k-' + over.tool + (over.ts ?? T1),
    ts: over.ts ?? T1,
    type: 'tool.executed',
    principalId: over.principalId ?? 'agent-1',
    source: 'kernel',
    payload: {
      tool: over.tool,
      auditClass: over.auditClass ?? 'mutate',
      ok: over.ok ?? true,
      ...(over.activity === undefined ? {} : { activity: over.activity }),
    },
  }
}

async function setup(input: { ee?: FakeEe; statusThrows?: Error; events?: KernelEvent[] }) {
  const ee = input.ee ?? new FakeEe()
  const activityEe = input.statusThrows
    ? {
        status: async () => {
          throw input.statusThrows
        },
      }
    : ee
  const toolEvents = async () => input.events ?? []
  const tools = createActivityTools({ ee: activityEe, toolEvents })
  const tool = tools.find((t) => t.name === WEBSITE_ACTIVITY_TOOL) as ToolDescriptor
  const run = (i: unknown = {}) => tool.handler(human, i)
  return { tool, run }
}

describe('website.activity: server events from ee, mapped by type', () => {
  it('maps deploy events to kind deploy, the plain sentence and the app link', async () => {
    const { run } = await setup({
      ee: Object.assign(new FakeEe(), {
        journal: [eeEvent('deploy.succeeded', 'shop', T1), eeEvent('deploy.started', 'shop', T0)],
      }),
    })
    const out = (await run()) as { managed: boolean; items: Array<Record<string, unknown>> }
    expect(out.managed).toBe(true)
    expect(out.items).toEqual([
      {
        at: T1,
        source: 'server',
        kind: 'deploy',
        text: 'Deployed shop',
        workload: 'shop',
        href: '/m/website/apps/shop',
      },
      {
        at: T0,
        source: 'server',
        kind: 'deploy',
        text: 'Started deploying shop',
        workload: 'shop',
        href: '/m/website/apps/shop',
      },
    ])
  })

  it('maps the other known ee types (secret, deploy key, workload life cycle, edges)', async () => {
    const { run } = await setup({
      ee: Object.assign(new FakeEe(), {
        journal: [
          eeEvent('secret.set', 'shop', T0),
          eeEvent('deploy_key.created', null, T0),
          eeEvent('deploy_key.deleted', null, T0),
          eeEvent('workload.error', 'shop', T0),
          eeEvent('workload.repaired', 'shop', T0),
          eeEvent('workload.removed', 'shop', T0),
          eeEvent('edge.updated', null, T0),
          eeEvent('state.committed', null, T0),
          eeEvent('claim.issued', null, T0),
        ],
      }),
    })
    const out = (await run()) as {
      items: Array<{ kind: string; text: string; href: string | null }>
    }
    const byText = new Map(out.items.map((i) => [i.text, i]))
    expect(byText.get('Set a secret for shop')).toMatchObject({
      kind: 'secret',
      href: '/m/website/apps/shop',
    })
    expect(byText.get('Added a deploy key')).toMatchObject({ kind: 'key', href: null })
    expect(byText.get('Removed a deploy key')).toMatchObject({ kind: 'key', href: null })
    expect(byText.get('shop hit an error')).toMatchObject({
      kind: 'server',
      href: '/m/website/apps/shop',
    })
    expect(byText.get('Repaired shop')).toMatchObject({ kind: 'server' })
    expect(byText.get('Removed shop')).toMatchObject({ kind: 'server' })
    expect(byText.get('Updated the server’s edge routing')).toMatchObject({
      kind: 'server',
      href: null,
    })
    expect(byText.get('Applied a change to the server')).toMatchObject({ kind: 'server' })
    expect(byText.get('Set up this server (ee)')).toMatchObject({ kind: 'server' })
  })

  it('the OS workload and unowned events link nowhere (the OS has no app page)', async () => {
    const { run } = await setup({
      ee: Object.assign(new FakeEe(), {
        journal: [eeEvent('deploy.succeeded', 'os', T0)],
      }),
    })
    const out = (await run()) as { items: Array<{ text: string; href: string | null }> }
    expect(out.items[0]).toMatchObject({ text: 'Deployed os', href: null })
  })

  it('unknown ee types show the type verbatim as kind server (never the message text)', async () => {
    const { run } = await setup({
      ee: Object.assign(new FakeEe(), {
        journal: [eeEvent('future.thing', null, T0, 'a very chatty message')],
      }),
    })
    const out = (await run()) as { items: Array<{ kind: string; text: string }> }
    expect(out.items).toEqual([
      {
        at: T0,
        source: 'server',
        kind: 'server',
        text: 'future.thing',
        workload: null,
        href: null,
      },
    ])
  })

  it('ee away (not managed): managed:false with the kernel tool events still shown', async () => {
    const { run } = await setup({
      statusThrows: new SubstrateUnavailableError('ENOENT'),
      events: [toolEvent({ tool: 'website.app_deploy', activity: 'Deployed shop' })],
    })
    const out = (await run()) as { managed: boolean; items: Array<{ text: string }> }
    expect(out.managed).toBe(false)
    expect(out.items.map((i) => i.text)).toEqual(['Deployed shop'])
  })

  it('another ee problem stays loud, in plain words', async () => {
    const { run } = await setup({
      statusThrows: new SubstrateError(502, 'boom'),
      events: [],
    })
    await expect(run()).rejects.toThrow(
      "The server's deploy agent could not read the server status",
    )
  })
})

describe('website.activity: tool events from the kernel audit', () => {
  it('kind by tool id (structural map) and the audit’s own activity sentence', async () => {
    const { run } = await setup({
      events: [
        toolEvent({
          tool: 'website.app_deploy',
          activity: 'Deployed shop from kindred/shop',
          ts: T0,
        }),
        toolEvent({ tool: 'website.app_domain_set', activity: 'Pointed a.example.com at shop' }),
        toolEvent({
          tool: 'substrate.domain_add',
          activity: 'Pointed the domain b.example.com at this server',
        }),
        toolEvent({ tool: 'substrate.secret_set', activity: 'Set the secret API_KEY for shop' }),
        toolEvent({
          tool: 'website.github_deploy_key_create',
          activity: 'Added a deploy key for kindred/shop',
        }),
        toolEvent({ tool: 'website.app_remove', activity: 'Removed the app “shop”' }),
        toolEvent({ tool: 'github.app_create', activity: 'Deployed kindred/old as the app “old”' }),
        toolEvent({ tool: 'website.publish_page', activity: 'Published the About page' }),
        toolEvent({ tool: 'website.create_page' }),
        toolEvent({ tool: 'website.update_page' }),
        toolEvent({ tool: 'website.github_connect_repo', activity: 'Connected kindred/shop' }),
      ],
    })
    const out = (await run()) as { items: Array<{ source: string; kind: string; text: string }> }
    const byText = new Map(out.items.map((i) => [i.text, i]))
    expect(out.items.every((i) => i.source === 'tool')).toBe(true)
    expect(byText.get('Deployed shop from kindred/shop')).toMatchObject({ kind: 'deploy' })
    expect(byText.get('Pointed a.example.com at shop')).toMatchObject({ kind: 'domain' })
    expect(byText.get('Pointed the domain b.example.com at this server')).toMatchObject({
      kind: 'domain',
    })
    expect(byText.get('Set the secret API_KEY for shop')).toMatchObject({ kind: 'secret' })
    expect(byText.get('Added a deploy key for kindred/shop')).toMatchObject({ kind: 'key' })
    expect(byText.get('Removed the app “shop”')).toMatchObject({ kind: 'app' })
    expect(byText.get('Deployed kindred/old as the app “old”')).toMatchObject({ kind: 'app' })
    expect(byText.get('Published the About page')).toMatchObject({ kind: 'page' })
    expect(byText.get('Connected kindred/shop')).toMatchObject({ kind: 'server' })
  })

  it('without a stored activity sentence: "<actor> ran <tool>" (the audit’s principal)', async () => {
    const { run } = await setup({
      events: [toolEvent({ tool: 'website.create_page', principalId: 'human-u9' })],
    })
    const out = (await run()) as {
      items: Array<{ kind: string; text: string; workload: string | null; href: string | null }>
    }
    expect(out.items).toEqual([
      {
        at: T1,
        source: 'tool',
        kind: 'page',
        text: 'human-u9 ran website.create_page',
        workload: null,
        href: null,
      },
    ])
  })

  it("keeps only this module's namespaces, successful calls; reads are not work to show", async () => {
    const { run } = await setup({
      events: [
        toolEvent({ tool: 'email.send_mail', activity: 'Sent a mail' }),
        toolEvent({ tool: 'members.invite', activity: 'Invited someone' }),
        toolEvent({ tool: 'website.app_deploy', activity: 'Deployed shop', ok: false }),
        toolEvent({ tool: 'website.app_list', auditClass: 'read', activity: 'Listed the apps' }),
        toolEvent({
          tool: 'substrate.domain_add',
          activity: 'Pointed the domain x.example.com at this server',
        }),
      ],
    })
    const out = (await run()) as { items: Array<{ text: string }> }
    expect(out.items.map((i) => i.text)).toEqual([
      'Pointed the domain x.example.com at this server',
    ])
  })

  it('a malformed audit payload fails loud (never guessed)', async () => {
    const { run } = await setup({
      events: [
        {
          id: 'k-bad',
          ts: T1,
          type: 'tool.executed',
          payload: { nope: true },
        } as unknown as KernelEvent,
      ],
    })
    await expect(run()).rejects.toThrow(/malformed tool\.executed audit payload/)
  })
})

describe('website.activity: shape', () => {
  it('merges both sources, newest first, truncated to the limit', async () => {
    const { run } = await setup({
      ee: Object.assign(new FakeEe(), {
        journal: [eeEvent('deploy.succeeded', 'shop', T0), eeEvent('edge.updated', null, T2)],
      }),
      events: [
        toolEvent({
          tool: 'website.app_deploy',
          activity: 'Deployed shop from kindred/shop',
          ts: T1,
        }),
      ],
    })
    const out = (await run({ limit: 2 })) as {
      managed: boolean
      items: Array<{ at: string }>
    }
    expect(out.items.map((i) => i.at)).toEqual([T2, T1])
  })

  it('truncates to the default of 20 when no limit is given', async () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      toolEvent({
        tool: 'website.app_deploy',
        activity: `Deploy ${i}`,
        ts: new Date(Date.parse(T0) + i * 60_000).toISOString(),
      }),
    )
    const { run } = await setup({ events })
    const out = (await run({})) as { items: Array<{ text: string }> }
    expect(out.items).toHaveLength(20)
    expect(out.items[0]!.text).toBe('Deploy 24')
  })

  it('refuses a limit above 50, below 1, or fractional', async () => {
    const { tool } = await setup({})
    const { inputSchema, outputSchema } = tool
    expect(inputSchema.safeParse({ limit: 51 }).success).toBe(false)
    expect(inputSchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(inputSchema.safeParse({ limit: 1.5 }).success).toBe(false)
    expect(inputSchema.safeParse({}).success).toBe(true)
    expect(inputSchema.safeParse({ limit: 50 }).success).toBe(true)
    expect(outputSchema).toBeDefined()
  })
})
