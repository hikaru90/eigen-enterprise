import type { GatewayCompleteFn } from './gateway-model'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import {
  DbDurableConversationIndex,
  type DurableConversationIndex,
} from './conversation-index'
import { getDurableHarness, type DurableHarnessDeps } from './durable-harness'

/**
 * Production composition of the 'durable' LoopEngine (plan/phase-durable.md
 * D6): lazy globalThis harness singleton + Postgres conversation index + the
 * gateway-backed model provider. Boot passes the orchestrator persona as
 * `instructions` and registers the engine next to pi.
 */

export type DurableEngineFactoryOptions = {
  /** Composition-root env; defaults to process.env (boot.ts convention). */
  env?: Record<string, string | undefined>
  /** Overrides the Postgres conversation index (tests inject in-memory). */
  index?: DurableConversationIndex
  /** Overrides the gateway completion call (tests inject fakes; never a real LLM). */
  complete?: GatewayCompleteFn
  /** The agent persona prompt handed to durable runs as instructions. Required. */
  instructions: string
  /** Default gateway billing identity when a dispatch carries no llmUserId. */
  llmUserId?: string
}

/** The lazy pooled DB handle the kernel stores use (request-scoped in ALS). */
function defaultConversationIndex(): DurableConversationIndex {
  return new DbDurableConversationIndex(async () => {
    const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
    const scoped = appDbAsyncLocal.getStore()
    if (scoped) return scoped
    return createScopedDrizzle(appSql)
  })
}

export function createDurableEngine(options: DurableEngineFactoryOptions): {
  engine: DurableLoopEngine
  /** Open the harness now (resuming turns a restart interrupted); retries through a blue-green handover. */
  warmUp: () => Promise<void>
} {
  const index = options.index ?? defaultConversationIndex()
  const deps: DurableHarnessDeps = {
    env: options.env ?? process.env,
    index,
    ...(options.complete === undefined ? {} : { complete: options.complete }),
  }
  const engine = new DurableLoopEngine({
    harness: {
      conversation: async (input) => {
        const box = await getDurableHarness(deps)
        return box.engineHarness.conversation(input)
      },
    },
    instructions: options.instructions,
    ...(options.llmUserId === undefined ? {} : { llmUserId: options.llmUserId }),
  })
  const warmUp = async () => {
    // The lock wait inside getDurableHarness already outlasts a normal handover;
    // a few rounds cover a slow drain. Then fail loud — never run unowned.
    for (let attempt = 1; ; attempt++) {
      try {
        await getDurableHarness(deps)
        return
      } catch (err) {
        if (attempt >= 5) throw err
        console.warn(`[durable] harness open attempt ${attempt} failed, retrying:`, (err as Error).message)
      }
    }
  }
  return { engine, warmUp }
}
