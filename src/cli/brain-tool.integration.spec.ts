import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import type { EngineContext } from '$lib/kernel/engine'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'
import { createMemoryTools } from '../../modules/memory/tools'
import { ORCHESTRATOR_AGENT_ID } from '../../modules/orchestrator/brain'
import { createEeAgentTool } from './brain-tool'

/**
 * The brain calling a real tool through ee, on the test database
 * (plan/shared-memory-voice-agent-tools.md §3): a member's brain dispatch
 * runs `ee tool run reminders.create` / `reminders.list` through the CLI's
 * command handlers and the kernel registry with the live row-level-security
 * scope — as THAT member. Another member's brain, through the same ee tool,
 * sees none of it. No model: a scripted engine makes the calls a model would.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

vi.mock('$lib/server/capture/capture-enrich-worker', () => ({
  scheduleCaptureEnrichWorker: () => {},
}))

describe.skipIf(!DATABASE_URL)('the brain runs registry tools through ee as the person (test DB)', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const member = `ee_member_${tag}`
  const other = `ee_other_${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')

  const activations = new InMemoryActivationStore()
  const registry = new KernelRegistry({ principalScope: livePrincipalScope, activationStore: activations })
  for (const tool of createMemoryTools()) registry.register(tool)

  let script: (ctx: EngineContext) => Promise<unknown> = async () => undefined
  let result: unknown
  const runtime = new AgentRuntime({
    registry,
    isToolActive: async (name) => name.startsWith('memory.') || name.startsWith('reminders.'),
    eventSink: new InMemoryEventSink(),
    engines: new Map([
      [
        'scripted',
        {
          run: async (_s: string, _i: string, ctx: EngineContext) => {
            result = await script(ctx)
            return 'ok'
          },
        },
      ],
    ]),
    metaTools: [createEeAgentTool({ registry, activations })],
  })
  runtime.registerAgent({
    id: ORCHESTRATOR_AGENT_ID,
    personaName: 'Brain',
    description: 'integration',
    loopEngine: 'scripted',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    instructions: 'engine-default',
    actsAs: 'person',
    task: 'assistant.turn',
    enabled: true,
  })
  const brainOf = async (id: string, run: (ctx: EngineContext) => Promise<unknown>) => {
    script = run
    await runtime.dispatch(ORCHESTRATOR_AGENT_ID, `s-${id}`, 'remind me', undefined, { person: { id, roles: ['member'] } })
    return result
  }

  beforeAll(async () => {
    await activations.set('memory', true)
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const id of [member, other]) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, 'member', ${`${id}@test.local`}, true, true, 'member')`
    }
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${member}, ${other})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('creates and lists the member’s own reminder through ee; another member’s brain cannot see it', async () => {
    const created = (await brainOf(member, (ctx) =>
      ctx.executeTool('ee', {
        args: ['tool', 'run', 'reminders.create'],
        input: { title: 'Send the LinkedIn posts', weekdays: ['MO', 'TH'], time: '09:00', time_zone: 'Europe/Berlin' },
      }),
    )) as { id: string; title: string }
    expect(created).toMatchObject({ title: 'Send the LinkedIn posts', weekdays: ['MO', 'TH'], time: '09:00' })

    // Discovery found it first, the way the model would.
    const discovered = (await brainOf(member, async (ctx) => ({
      list: await ctx.executeTool('ee', { args: ['tool', 'list', '--namespace', 'reminders'] }),
      help: await ctx.executeTool('ee', { args: ['tool', 'help', 'reminders.create'] }),
    }))) as { list: Array<{ name: string }>; help: { inputSchema: { required?: string[] } } }
    expect(discovered.list.map((t) => t.name)).toContain('reminders.list')
    expect(discovered.help.inputSchema.required).toEqual(expect.arrayContaining(['title', 'weekdays', 'time']))

    const mine = (await brainOf(member, (ctx) => ctx.executeTool('ee', { args: ['tool', 'run', 'reminders.list'], input: {} }))) as {
      reminders: Array<{ id: string }>
    }
    expect(mine.reminders.map((r) => r.id)).toContain(created.id)
    const [row] = await operator`select user_id from reminders where id = ${created.id}`
    expect(row).toEqual({ user_id: member })

    const theirs = (await brainOf(other, (ctx) => ctx.executeTool('ee', { args: ['tool', 'run', 'reminders.list'], input: {} }))) as {
      reminders: Array<{ id: string }>
    }
    expect(theirs.reminders.map((r) => r.id)).not.toContain(created.id)
  })
})
