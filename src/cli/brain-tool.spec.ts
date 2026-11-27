import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentConfig } from '$lib/kernel/agent'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import { StaticApprovalPolicy } from '$lib/kernel/approvals'
import type { EngineContext, LoopEngine } from '$lib/kernel/engine'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { createEeAgentTool, EE_AGENT_TOOL_NAME } from './brain-tool'

/**
 * The company brain's `ee` tool (plan/shared-memory-voice-agent-tools.md §3):
 * the ee CLI as one model-facing tool — discovery (namespaces → list → help
 * with the input schema) and `tool run`, dispatched through the CLI's own
 * command handlers and the kernel registry AS THE PERSON. No escalation:
 * the registry's role check, approvals and audit are the same ones a direct
 * call meets.
 */

type Seen = { name: string; ctx: ToolContext; input: unknown }

function tool(name: string, roles: string[], extra: Partial<ToolDescriptor> = {}, seen?: Seen[]): ToolDescriptor {
  return {
    name,
    module: name.split('.')[0],
    summary: `${name} summary`,
    inputSchema: z.object({ q: z.string().optional() }).strict(),
    permission: { roles },
    auditClass: 'read',
    handler: async (ctx, input) => {
      seen?.push({ name, ctx, input })
      return { ran: name, as: ctx.principal.id }
    },
    ...extra,
  }
}

async function fixture(options: { approvalGated?: string[] } = {}) {
  const seen: Seen[] = []
  const activations = new InMemoryActivationStore()
  for (const m of ['reminders', 'drive', 'website', 'kernel', 'dormant']) await activations.set(m, m !== 'dormant')
  const registry = new KernelRegistry({
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(new Set(options.approvalGated ?? [])),
  })
  registry.register(tool('reminders.list', ['admin', 'member'], {}, seen))
  registry.register(tool('drive.list', ['admin', 'member'], {}, seen))
  registry.register(
    tool('drive.write_text', ['admin', 'member'], { auditClass: 'mutate', approvalRisk: 'low', activity: () => 'Wrote a file' }, seen),
  )
  registry.register(tool('website.create_page', ['admin'], {}, seen))
  registry.register(tool('kernel.module_list', ['admin'], {}, seen))
  registry.register(tool('dormant.ping', ['admin', 'member'], {}, seen))
  const isToolActive = async (name: string) => activations.get(name.split('.')[0])
  const ee = createEeAgentTool({ registry, activations })
  const agent: AgentConfig = {
    id: 'orchestrator',
    personaName: 'Brain',
    description: 'test',
    loopEngine: 'scripted',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    instructions: 'engine-default',
    actsAs: 'person',
    task: 'assistant.turn',
    enabled: true,
  }
  return { seen, activations, registry, isToolActive, ee, agent }
}

const member = { id: 'm-1', roles: ['member'] }
const admin = { id: 'a-1', roles: ['admin', 'member'] }

/** Runs `script` inside a real AgentRuntime dispatch (the path the chat takes). */
async function inDispatch<T>(
  f: Awaited<ReturnType<typeof fixture>>,
  person: { id: string; roles: string[] },
  script: (ctx: EngineContext) => Promise<T>,
  agent = f.agent,
): Promise<T> {
  let out: T | undefined
  const engine: LoopEngine = {
    run: async (_s, _i, ctx) => {
      out = await script(ctx)
      return 'ok'
    },
  }
  const runtime = new AgentRuntime({
    registry: f.registry,
    isToolActive: f.isToolActive,
    eventSink: new InMemoryEventSink(),
    engines: new Map([['scripted', engine]]),
    metaTools: [f.ee],
  })
  runtime.registerAgent({ ...agent })
  await runtime.dispatch(agent.id, 's-1', 'hi', undefined, { person })
  return out as T
}

describe('the brain’s ee tool — offered', () => {
  it('is one tool on every person’s surface, next to the direct tools (none removed)', async () => {
    const f = await fixture()
    for (const person of [member, admin]) {
      const names = await inDispatch(f, person, async (ctx) => ctx.listTools().map((t) => t.name))
      expect(names).toContain(EE_AGENT_TOOL_NAME)
      expect(names).toContain('reminders.list')
      expect(names).toContain('drive.list')
    }
    const listing = f.ee.listing
    expect(listing.name).toBe('ee')
    // Small: the listing teaches discovery, it carries no tool schemas.
    expect(JSON.stringify(listing).length).toBeLessThan(2500)
    expect(listing.inputJsonSchema).toMatchObject({ type: 'object', required: ['args'] })
  })

  it('a meta tool may not shadow a registered kernel tool (fails loud)', async () => {
    const f = await fixture()
    const shadow = { ...f.ee, listing: { ...f.ee.listing, name: 'drive.list' } }
    const runtime = new AgentRuntime({
      registry: f.registry,
      isToolActive: f.isToolActive,
      eventSink: new InMemoryEventSink(),
      metaTools: [shadow],
    })
    runtime.registerAgent({ ...f.agent })
    await expect(runtime.listAgentTools(f.agent.id, member)).rejects.toThrow(/shadows the kernel tool drive\.list/)
  })
})

describe('the brain’s ee tool — discovery within the person’s reach', () => {
  it('namespaces → list → help: only what the person may run, schemas only on help', async () => {
    const f = await fixture()
    const r = await inDispatch(f, member, async (ctx) => ({
      namespaces: await ctx.executeTool('ee', { args: ['tool', 'namespaces'] }),
      list: await ctx.executeTool('ee', { args: ['tool', 'list', '--namespace', 'drive'] }),
      all: await ctx.executeTool('ee', { args: ['tool', 'list'] }),
      help: await ctx.executeTool('ee', { args: ['tool', 'help', 'reminders.list'] }),
    }))
    expect(r.namespaces).toEqual([
      { namespace: 'drive', tools: 2 },
      { namespace: 'reminders', tools: 1 },
    ])
    expect(r.list).toEqual([
      { name: 'drive.list', description: 'drive.list summary' },
      { name: 'drive.write_text', description: 'drive.write_text summary' },
    ])
    expect((r.all as Array<{ name: string }>).map((t) => t.name).sort()).toEqual(['drive.list', 'drive.write_text', 'reminders.list'])
    expect(r.help).toMatchObject({
      name: 'reminders.list',
      description: 'reminders.list summary',
      module: 'reminders',
      auditClass: 'read',
      active: true,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    })
  })

  it('an admin sees the admin tools too', async () => {
    const f = await fixture()
    const all = await inDispatch(f, admin, (ctx) => ctx.executeTool('ee', { args: ['tool', 'list'] }))
    expect((all as Array<{ name: string }>).map((t) => t.name).sort()).toEqual([
      'drive.list',
      'drive.write_text',
      'kernel.module_list',
      'reminders.list',
      'website.create_page',
    ])
  })

  it('help on a tool outside the person’s reach is refused; an unknown tool is unknown', async () => {
    const f = await fixture()
    await inDispatch(f, member, async (ctx) => {
      await expect(ctx.executeTool('ee', { args: ['tool', 'help', 'website.create_page'] })).rejects.toMatchObject({
        code: 'permission_denied',
        message: expect.stringMatching(/website\.create_page is not within your reach/),
      })
      await expect(ctx.executeTool('ee', { args: ['tool', 'help', 'nope.nothing'] })).rejects.toMatchObject({ code: 'unknown_tool' })
    })
  })

  it('a tool of an inactive module is not listed; help says so; running it meets the registry’s module gate', async () => {
    const f = await fixture()
    await inDispatch(f, member, async (ctx) => {
      const all = (await ctx.executeTool('ee', { args: ['tool', 'list'] })) as Array<{ name: string }>
      expect(all.map((t) => t.name)).not.toContain('dormant.ping')
      expect(await ctx.executeTool('ee', { args: ['tool', 'help', 'dormant.ping'] })).toMatchObject({ active: false })
      await expect(ctx.executeTool('ee', { args: ['tool', 'run', 'dormant.ping'], input: {} })).rejects.toMatchObject({
        code: 'module_inactive',
      })
    })
  })
})

describe('the brain’s ee tool — runs as the person, never more', () => {
  it('tool run executes through the registry as the delegated person (id, roles, via brain)', async () => {
    const f = await fixture()
    const out = await inDispatch(f, member, (ctx) =>
      ctx.executeTool('ee', { args: ['tool', 'run', 'reminders.list'], input: { q: 'x' } }),
    )
    expect(out).toEqual({ ran: 'reminders.list', as: 'm-1' })
    expect(f.seen).toHaveLength(1)
    expect(f.seen[0].input).toEqual({ q: 'x' })
    expect(f.seen[0].ctx.principal).toEqual({ id: 'm-1', kind: 'human', roles: ['member'], via: 'brain', agentId: 'orchestrator' })
  })

  it('an admin-only tool is refused for a member with the registry’s permission error; nothing runs', async () => {
    const f = await fixture()
    await inDispatch(f, member, async (ctx) => {
      for (const args of [['tool', 'run', 'website.create_page'], ['module', 'list'], ['status']]) {
        await expect(ctx.executeTool('ee', { args, input: args[0] === 'tool' ? {} : undefined })).rejects.toMatchObject({
          code: 'permission_denied',
        })
      }
    })
    expect(f.seen).toEqual([])
  })

  it('the brain cannot pick another principal, and openapi (every schema) is not offered', async () => {
    const f = await fixture()
    await inDispatch(f, member, async (ctx) => {
      await expect(
        ctx.executeTool('ee', { args: ['tool', 'run', 'reminders.list', '--principal', 'a-1'], input: {} }),
      ).rejects.toMatchObject({ code: 'permission_denied', message: expect.stringMatching(/runs as the person/) })
      await expect(ctx.executeTool('ee', { args: ['openapi'] })).rejects.toMatchObject({ code: 'invalid_input' })
    })
    expect(f.seen).toEqual([])
  })

  it('malformed calls fail loud with usage (invalid_input), not silently', async () => {
    const f = await fixture()
    await inDispatch(f, member, async (ctx) => {
      await expect(ctx.executeTool('ee', { args: [] })).rejects.toMatchObject({ code: 'invalid_input' })
      await expect(ctx.executeTool('ee', { args: ['tool', 'run', 'reminders.list'] })).rejects.toMatchObject({
        code: 'invalid_input',
        message: expect.stringMatching(/input/),
      })
      await expect(
        ctx.executeTool('ee', { args: ['tool', 'run', 'reminders.list', '--input', '{}'], input: {} }),
      ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/either/) })
      await expect(ctx.executeTool('ee', { nope: true })).rejects.toMatchObject({ code: 'invalid_input' })
    })
  })

  it('the agent’s tool scope holds through ee too', async () => {
    const f = await fixture()
    const scoped = { ...f.agent, toolScope: { modules: ['reminders'] } }
    await inDispatch(
      f,
      admin,
      async (ctx) => {
        const all = (await ctx.executeTool('ee', { args: ['tool', 'list'] })) as Array<{ name: string }>
        expect(all.map((t) => t.name)).toEqual(['reminders.list'])
        await expect(ctx.executeTool('ee', { args: ['tool', 'run', 'drive.list'], input: {} })).rejects.toMatchObject({
          code: 'permission_denied',
          message: expect.stringMatching(/outside this agent’s tool scope/),
        })
      },
      scoped,
    )
    expect(f.seen).toEqual([])
  })

  it('an approval-gated tool through ee waits for approval exactly like a direct call (card names the real tool)', async () => {
    const f = await fixture({ approvalGated: ['drive.write_text'] })
    const surface: unknown[] = []
    let result: unknown
    const durable = new DurableLoopEngine({
      instructions: 'test',
      harness: {
        startBackgroundRun: async () => {
          throw new Error('not used')
        },
        conversation: async (input) => ({
          id: 'c-1',
          submitAndSettle: async () => {
            const ee = input.tools.find((t) => t.name === 'ee')!
            result = await ee.execute({ args: ['tool', 'run', 'drive.write_text'], input: { q: 'hello' } })
            return { status: 'answered', reply: 'done' }
          },
        }) as never,
      },
    })
    const runtime = new AgentRuntime({
      registry: f.registry,
      isToolActive: f.isToolActive,
      eventSink: new InMemoryEventSink(),
      engines: new Map([['durable', durable]]),
      metaTools: [f.ee],
    })
    runtime.registerAgent({ ...f.agent, loopEngine: 'durable' })
    await runtime.dispatch(f.agent.id, 's-1', 'write it', { surfaceEvent: (e) => surface.push(e) }, { person: member })
    expect(result).toMatchObject({ status: 'approval_pending', tool: 'drive.write_text' })
    // The step names the real tool (not `ee`), secret-free input; it ends waiting for approval.
    expect(surface).toEqual([
      { type: 'tool.preview', stepId: expect.any(String), tool: 'drive.write_text', inputSummary: 'q: hello' },
      { type: 'approval.required', tool: 'drive.write_text', approvalId: expect.any(String) },
      {
        type: 'tool.finished',
        stepId: expect.any(String),
        tool: 'drive.write_text',
        failed: false,
        resultSummary: 'Waiting for approval; it has not run yet.',
      },
    ])
    const pending = await f.registry.getApprovalStore().latestFor('drive.write_text', 'm-1')
    expect(pending?.status).toBe('pending')
    expect(f.seen).toEqual([])
  })
})
