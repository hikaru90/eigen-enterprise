import type { GatewayCompleteFn } from './gateway-model'
import {
  DurableLoopEngine,
  type BackgroundRunHandle,
  type BackgroundRunInput,
  type BackgroundToolExecutor,
} from '$lib/kernel/engines/durable'
import {
  DbDurableConversationIndex,
  type DurableConversationIndex,
} from './conversation-index'
import {
  getDurableHarness,
  type DurableHarnessDeps,
  type ResumedChatTurn,
} from './durable-harness'

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
  /**
   * Executes background-run tool calls as their recorded principal (boot:
   * createPrincipalToolExecutor over the kernel registry). Required.
   */
  runAsPrincipal: BackgroundToolExecutor
  /** D9 chat mirror of resumed turns; defaults to the chat_message writer. */
  mirrorResumedChatTurn?: (turn: ResumedChatTurn) => Promise<void>
}

/** D9 default: write the resumed reply into chat_message (lazy DB import). */
async function defaultChatMirror(turn: ResumedChatTurn): Promise<void> {
  const { mirrorResumedChatTurn } = await import('$lib/server/chat/mirror-durable-turn')
  const outcome = await mirrorResumedChatTurn(turn)
  console.info(`[durable] resumed turn of ${turn.conversationKey} → chat mirror: ${outcome}`)
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
  /** Start a background run (software-factory §3.1): nobody awaits it; it survives restarts. */
  startBackgroundRun: (input: BackgroundRunInput) => Promise<BackgroundRunHandle>
} {
  const index = options.index ?? defaultConversationIndex()
  const deps: DurableHarnessDeps = {
    env: options.env ?? process.env,
    index,
    ...(options.complete === undefined ? {} : { complete: options.complete }),
    runAsPrincipal: options.runAsPrincipal,
    mirrorResumedChatTurn: options.mirrorResumedChatTurn ?? defaultChatMirror,
  }
  const startBackgroundRun = async (input: BackgroundRunInput) => {
    const box = await getDurableHarness(deps)
    return box.engineHarness.startBackgroundRun(input)
  }
  const engine = new DurableLoopEngine({
    harness: {
      conversation: async (input) => {
        const box = await getDurableHarness(deps)
        return box.engineHarness.conversation(input)
      },
      startBackgroundRun,
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
  return { engine, warmUp, startBackgroundRun }
}
