import { describe, expect, it } from 'vitest'
import { PiEngine, type EngineContext } from './pi-engine'

/**
 * Compile-time structural compatibility with the LoopEngine contract hosted by
 * wt/harness in src/lib/kernel/engine.ts:
 *
 *   interface LoopEngine { run(sessionId, input, ctx: EngineContext): Promise<string> }
 *   EngineContext = { agent, principal, executeTool, listTools, emit, spendUsd }
 *
 * engine.ts does not exist on this branch, so the quoted shapes are declared
 * here as fixtures and the orchestrator unifies them with the canonical types
 * at merge. Runtime-safe: run() is never called — nothing spawns, no network.
 */
type QuotedEngineContext = {
  agent: { id: string }
  principal: { id: string; kind: 'human' | 'agent' | 'service'; roles: string[] }
  executeTool(name: string, input: unknown): Promise<unknown>
  listTools(): Promise<unknown[]>
  emit(event: { type: string; payload?: unknown }): Promise<void>
  spendUsd(amountUsd: number): Promise<void>
}

type QuotedLoopEngine = {
  run(sessionId: string, input: string, ctx: QuotedEngineContext): Promise<string>
}

const neverSpawn = (): never => {
  throw new Error('compat spec never spawns')
}

describe('PiEngine <-> quoted LoopEngine structural contract', () => {
  it('satisfies the LoopEngine shape and accepts both context shapes', () => {
    const engine = new PiEngine({ spawnRunner: neverSpawn })

    // A fixture LoopEngine assignment: PiEngine satisfies the quoted contract.
    const asLoopEngine: QuotedLoopEngine = engine
    expect(asLoopEngine).toBe(engine)

    // A fixture object satisfying the LOCAL EngineContext type is assignable
    // where PiEngine.run expects its context parameter.
    const local: EngineContext = {
      agent: { id: 'agent-1' },
      principal: { id: 'p1', kind: 'agent', roles: ['owner'] },
      executeTool: async () => ({}),
      listTools: async () => [],
      emit: async () => {},
      spendUsd: () => {},
    }
    const atRunParam: Parameters<typeof engine.run>[2] = local
    expect(atRunParam).toBe(local)

    // A fixture with the QUOTED context shape satisfies the expectation too.
    const quoted: QuotedEngineContext = {
      agent: { id: 'agent-1' },
      principal: { id: 'p1', kind: 'agent', roles: ['owner'] },
      executeTool: async () => ({}),
      listTools: async () => [],
      emit: async () => {},
      spendUsd: async () => {},
    }
    const quotedAtRunParam: Parameters<typeof engine.run>[2] = quoted
    expect(quotedAtRunParam).toBe(quoted)
    const localFromQuoted: EngineContext = quoted
    expect(localFromQuoted).toBe(quoted)
  })
})
