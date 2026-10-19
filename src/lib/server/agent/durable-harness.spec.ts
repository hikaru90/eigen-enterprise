import type { GatewayCompleteFn } from './gateway-model'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAdminTools, kernelManifest } from '$lib/kernel/admin-tools'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import type { EngineContext } from '$lib/kernel/engine'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import { KernelError } from '$lib/kernel/errors'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import { InMemoryDurableConversationIndex } from './conversation-index'
import {
  acquireAgentStateLock,
  getDurableHarness,
  releaseAgentStateLock,
  resetDurableHarnessSingletonForTests,
  resolveAgentStateDir,
} from './durable-harness'
import { FileIndex } from './test-fixtures/file-index'

/**
 * Real pi-durable 1.3.0 on a temp SQLite file; only the gateway completion is
 * scripted (never a real LLM). Proves the engine ↔ harness ↔ kernel bridge.
 */

type Turn = { text?: string; call?: { name: string; args: Record<string, unknown> } }

/** Scripted gateway: per billing user, a queue of assistant turns (OpenAI response shape). */
function scriptedGateway(scripts: Record<string, Turn[]>) {
  const seen: Array<{ userId: string; messages: unknown[] }> = []
  const complete: GatewayCompleteFn = async (input) => {
    seen.push({ userId: input.userId, messages: input.messages })
    const turn = scripts[input.userId]?.shift()
    if (!turn) throw new Error(`no scripted turn left for ${input.userId}`)
    const message = turn.call
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: `call_${seen.length}`, type: 'function', function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }],
        }
      : { role: 'assistant', content: turn.text ?? '' }
    return {
      choices: [{ message, finish_reason: turn.call ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }
  }
  return { complete, seen }
}

function engineCtx(principalId: string, llmUserId: string, executed: string[]): EngineContext {
  return {
    agent: { id: 'orchestrator' },
    llmUserId,
    listTools: () => [
      {
        name: 'memory.echo',
        summary: 'Echo back the input',
        inputJsonSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    ],
    executeTool: async (name: string, args: unknown) => {
      executed.push(`${principalId}:${name}:${JSON.stringify(args)}`)
      return { echoed: (args as { text: string }).text, as: principalId }
    },
  } as unknown as EngineContext
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-durable-'))
  resetDurableHarnessSingletonForTests()
})

afterEach(() => {
  resetDurableHarnessSingletonForTests()
  rmSync(dir, { recursive: true, force: true })
})

function engineFor(complete: GatewayCompleteFn) {
  const index = new InMemoryDurableConversationIndex()
  const deps = { env: { EE_AGENT_STATE_DIR: dir }, index, complete, onReport: () => {} }
  const engine = new DurableLoopEngine({
    harness: { conversation: async (input) => (await getDurableHarness(deps)).engineHarness.conversation(input) },
    instructions: 'You are a test agent.',
  })
  return { engine, index }
}

describe('resolveAgentStateDir (D2: never a default location)', () => {
  it('prefers EE_AGENT_STATE_DIR, then $EE_STATE_DIR/agent, else fails loud', () => {
    expect(resolveAgentStateDir({ EE_AGENT_STATE_DIR: '/x', EE_STATE_DIR: '/y' })).toBe('/x')
    expect(resolveAgentStateDir({ EE_STATE_DIR: '/var/lib/ee-state/os' })).toBe('/var/lib/ee-state/os/agent')
    expect(() => resolveAgentStateDir({})).toThrow(/not configured/)
  })
})

describe('agent state lock (D3: one owner per file)', () => {
  it('a live other owner blocks acquisition (async, bounded), then fails loud', async () => {
    writeFileSync(join(dir, 'agent.lock'), String(process.ppid)) // the test runner's parent: alive
    const started = Date.now()
    await expect(acquireAgentStateLock(dir, { retryWindowMs: 300, pollMs: 50 })).rejects.toThrow(/owned by pid/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(250)
  })

  it('steals a dead owner\'s lock and releases only its own stamp', async () => {
    writeFileSync(join(dir, 'agent.lock'), '999999999')
    const lock = await acquireAgentStateLock(dir, { retryWindowMs: 100 })
    expect(readFileSync(join(dir, 'agent.lock'), 'utf8')).toBe(String(process.pid))
    releaseAgentStateLock(lock)
    expect(() => readFileSync(join(dir, 'agent.lock'))).toThrow()
  })

  it('does not block the event loop while waiting', async () => {
    writeFileSync(join(dir, 'agent.lock'), String(process.ppid))
    let ticks = 0
    const timer = setInterval(() => ticks++, 10)
    await acquireAgentStateLock(dir, { retryWindowMs: 200, pollMs: 50 }).catch(() => {})
    clearInterval(timer)
    expect(ticks).toBeGreaterThan(5)
  })
})

describe('durable engine over real pi-durable', () => {
  it('answers a plain turn and indexes the conversation for billing attribution', async () => {
    const { complete, seen } = scriptedGateway({ alice: [{ text: 'hello alice' }] })
    const { engine, index } = engineFor(complete)
    const reply = await engine.run('s1', 'hi', engineCtx('alice', 'alice', []))
    expect(reply).toBe('hello alice')
    expect(seen[0]?.userId).toBe('alice')
    expect(await index.resolveByConversationKey('orchestrator:s1')).toMatchObject({ llmUserId: 'alice' })
  })

  it('a tool call runs through the kernel bridge, and the model sees the result', async () => {
    const executed: string[] = []
    const { complete, seen } = scriptedGateway({
      alice: [{ call: { name: 'memory.echo', args: { text: 'ping' } } }, { text: 'done' }],
    })
    const { engine } = engineFor(complete)
    expect(await engine.run('s1', 'echo ping', engineCtx('alice', 'alice', executed))).toBe('done')
    expect(executed).toEqual(['alice:memory.echo:{"text":"ping"}'])
    const second = JSON.stringify(seen[1]?.messages)
    expect(second).toContain('"role":"tool"')
    expect(second).toContain('ping')
  })

  it('two users at once: each tool call runs as its own dispatch, never the other one', async () => {
    const executed: string[] = []
    const { complete } = scriptedGateway({
      alice: [{ call: { name: 'memory.echo', args: { text: 'a' } } }, { text: 'alice done' }],
      bob: [{ call: { name: 'memory.echo', args: { text: 'b' } } }, { text: 'bob done' }],
    })
    const { engine } = engineFor(complete)
    const [a, b] = await Promise.all([
      engine.run('sa', 'x', engineCtx('alice', 'alice', executed)),
      engine.run('sb', 'y', engineCtx('bob', 'bob', executed)),
    ])
    expect([a, b]).toEqual(['alice done', 'bob done'])
    expect(executed.sort()).toEqual(['alice:memory.echo:{"text":"a"}', 'bob:memory.echo:{"text":"b"}'])
  })

  it('an approval-gated tool reports approval_pending to the model instead of failing the run', async () => {
    const { complete, seen } = scriptedGateway({
      alice: [{ call: { name: 'memory.echo', args: { text: 'publish' } } }, { text: 'pending approval' }],
    })
    const { engine } = engineFor(complete)
    const ctx = engineCtx('alice', 'alice', [])
    ;(ctx as { executeTool: unknown }).executeTool = async () => {
      throw new KernelError('approval_required', 'needs owner')
    }
    expect(await engine.run('s1', 'publish', ctx)).toBe('pending approval')
    expect(JSON.stringify(seen[1]?.messages)).toContain('approval_pending')
  })

  it('module_inactive comes back as a tool result; the agent activates the module and retries', async () => {
    const activations = new InMemoryActivationStore()
    const modules = new ModuleRegistry(activations)
    const registry = new KernelRegistry({ activationStore: activations })
    modules.register(kernelManifest)
    modules.register({ id: 'website', name: 'Website', version: '0.1.0', tools: ['website.list_pages'], permissions: { roles: ['admin'] } })
    await activations.set('kernel', true)
    const approvals = Object.assign(new InMemoryApprovalStore(), { list: async () => [] })
    for (const tool of createAdminTools({ modules, activations, approvals })) registry.register(tool)
    registry.register({
      name: 'website.list_pages',
      module: 'website',
      summary: 'List pages',
      auditClass: 'read',
      inputSchema: z.object({}),
      permission: { roles: ['admin'] },
      handler: async () => [{ slug: 'home' }],
    })
    const principal = { id: 'orchestrator', kind: 'agent' as const, roles: ['admin', 'agent'] }
    const ctx = {
      agent: { id: 'orchestrator' },
      llmUserId: 'alice',
      listTools: () =>
        ['website.list_pages', 'kernel.module_activate'].map((name) => ({
          name,
          summary: name,
          inputJsonSchema: { type: 'object', properties: {} },
        })),
      executeTool: (name: string, input: unknown) => registry.execute(name, input, { principal, requestId: 'r1' }),
    } as unknown as EngineContext
    const { complete, seen } = scriptedGateway({
      alice: [
        { call: { name: 'website.list_pages', args: {} } },
        { call: { name: 'kernel.module_activate', args: { module_id: 'website' } } },
        { call: { name: 'website.list_pages', args: {} } },
        { text: 'You have one page: home.' },
      ],
    })
    const { engine } = engineFor(complete)
    expect(await engine.run('s1', 'what pages do I have?', ctx)).toBe('You have one page: home.')
    const afterFailure = JSON.stringify(seen[1]?.messages)
    expect(afterFailure).toContain('module_inactive')
    expect(afterFailure).toContain('kernel.module_activate')
    expect(await activations.get('website')).toBe(true)
    expect(JSON.stringify(seen[3]?.messages)).toContain('home')
  })

  it('handler and validation errors come back as structured tool results, secrets redacted', async () => {
    const { complete, seen } = scriptedGateway({
      alice: [{ call: { name: 'memory.echo', args: { text: 'x' } } }, { call: { name: 'memory.echo', args: { text: 'y' } } }, { text: 'could not' }],
    })
    const { engine } = engineFor(complete)
    const ctx = engineCtx('alice', 'alice', [])
    let calls = 0
    ;(ctx as { executeTool: unknown }).executeTool = async () => {
      calls++
      if (calls === 1) throw new KernelError('invalid_input', 'bad args', { api_key: 'sk-live-123', field: 'text' })
      z.object({ n: z.number() }).parse({ n: 'nope' })
    }
    expect(await engine.run('s1', 'x', ctx)).toBe('could not')
    const first = JSON.stringify(seen[1]?.messages)
    expect(first).toContain('invalid_input')
    expect(first).not.toContain('sk-live-123')
    expect(JSON.stringify(seen[2]?.messages)).toContain('invalid_input')
  })

  it('a non-tool infrastructure failure (harness) still fails loud', async () => {
    const engine = new DurableLoopEngine({
      harness: {
        conversation: async () => {
          throw new Error('durable storage unavailable')
        },
      },
      instructions: 'You are a test agent.',
    })
    await expect(engine.run('s1', 'hi', engineCtx('alice', 'alice', []))).rejects.toThrow('durable storage unavailable')
  })

  it('a gateway failure mid-turn still fails the run (not a tool result)', async () => {
    const { complete } = scriptedGateway({ alice: [] })
    const { engine } = engineFor(complete)
    await expect(engine.run('s1', 'hi', engineCtx('alice', 'alice', []))).rejects.toThrow()
  })

  it('remembers the conversation across turns (history comes from durable storage)', async () => {
    const { complete, seen } = scriptedGateway({ alice: [{ text: 'first' }, { text: 'second' }] })
    const { engine } = engineFor(complete)
    await engine.run('s1', 'one', engineCtx('alice', 'alice', []))
    await engine.run('s1', 'two', engineCtx('alice', 'alice', []))
    const history = JSON.stringify(seen[1]?.messages)
    expect(history).toContain('one')
    expect(history).toContain('first')
  })
})

describe('crash-resume (the point of durability)', () => {
  it('a turn whose process was SIGKILLed mid-model-call completes after reopen, from its checkpoint', async () => {
    // 1) A child process starts the turn and dies (SIGKILL) while the model call is in flight.
    const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), [join(__dirname, 'test-fixtures/crash-child.ts'), dir], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += String(d)))
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child never reached the model call: ${stderr}`)), 60_000)
      child.stdout.on('data', (d) => {
        if (String(d).includes('IN_FLIGHT')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('exit', (code) => reject(new Error(`child exited early (${code}): ${stderr}`)))
    })
    child.removeAllListeners('exit')
    const dead = new Promise((r) => child.on('exit', r))
    child.kill('SIGKILL')
    await dead

    // 2) This process reopens the same state: the dead owner's lock is stolen, the
    //    pending turn resumes, and its answer lands before the next turn runs.
    const { complete, seen } = scriptedGateway({ alice: [{ text: 'resumed answer' }, { text: 'next answer' }] })
    const index = new FileIndex(join(dir, 'index.json'))
    const deps = { env: { EE_AGENT_STATE_DIR: dir }, index, complete, onReport: () => {} }
    const engine = new DurableLoopEngine({
      harness: { conversation: async (input) => (await getDurableHarness(deps)).engineHarness.conversation(input) },
      instructions: 'You are a test agent.',
    })
    expect(await engine.run('s1', 'and now?', engineCtx('alice', 'alice', []))).toBe('next answer')
    const resumedCall = JSON.stringify(seen[0]?.messages)
    expect(resumedCall).toContain('crash me') // the interrupted turn was re-run, not lost
    const nextCall = JSON.stringify(seen[1]?.messages)
    expect(nextCall).toContain('resumed answer') // and its answer is part of the history
  }, 120_000)
})
