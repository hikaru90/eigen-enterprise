import type { GatewayCompleteFn } from './gateway-model'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EngineContext } from '$lib/kernel/engine'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import { KernelError } from '$lib/kernel/errors'
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
