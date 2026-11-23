import type { AgentConfig, CoworkerSource } from '$lib/kernel/agent'
import type { StreamFrame } from '../../../../modules/messages/hub'
import type { CoworkerView } from './service'
import type { CoworkerTurns, TurnPrompts } from './turns'
import { coworkerPrincipal } from '$lib/kernel/principals'

/**
 * The company's enabled AI co-workers as runtime agents (plan/phase-ai-coworkers.md
 * §5): one AgentConfig per co-worker, from the database — its own model, its
 * own daily cap on the cost ledger, its own principal, and the prompt its turn
 * assembled (TurnPrompts). AgentRuntime.loadAgents(source) keeps exactly this
 * set registered; call it at boot, after every change and before every turn.
 */
export function coworkerAgentConfig(view: CoworkerView, prompts: TurnPrompts): AgentConfig {
  return {
    id: view.agentId,
    personaName: view.name,
    description: `AI co-worker: ${view.title ?? view.name}`,
    loopEngine: 'durable',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    instructions: (turn) => prompts.get(turn.sessionId),
    modelId: view.modelId,
    actsAs: {
      kind: 'self',
      principalFor: () => coworkerPrincipal(view.id, view.agentId),
      dailySpendCapUsd: view.dailyCapUsd,
    },
    enabled: true,
  }
}

export function coworkerAgentSource(deps: { listEnabled: () => Promise<CoworkerView[]>; prompts: TurnPrompts }): CoworkerSource {
  return {
    listAgentConfigs: async () => (await deps.listEnabled()).map((view) => coworkerAgentConfig(view, deps.prompts)),
  }
}

/** What the trigger listener needs of the messages hub. */
export type MessageFrames = {
  subscribe(userId: string, send: (frame: StreamFrame) => void): () => void
}

/**
 * Hears new messages as each enabled co-worker: the messages hub (one per app
 * process, fed by LISTEN ee_messages) sends a co-worker exactly the frames of
 * conversations it may see, and every created message goes to the turns, which
 * decide whether it asks for a turn. `refresh` follows the current co-workers.
 */
export class CoworkerTriggerListener {
  private readonly subs = new Map<string, () => void>()
  private stopped = false

  constructor(
    private readonly deps: {
      hub: MessageFrames
      listEnabled: () => Promise<CoworkerView[]>
      turns: Pick<CoworkerTurns, 'onMessage'>
    },
  ) {}

  /** Who it listens as right now. */
  listening(): string[] {
    return [...this.subs.keys()].sort()
  }

  async refresh(): Promise<void> {
    if (this.stopped) return
    const wanted = new Set((await this.deps.listEnabled()).map((c) => c.id))
    if (this.stopped) return
    for (const [id, unsubscribe] of this.subs) {
      if (wanted.has(id)) continue
      unsubscribe()
      this.subs.delete(id)
    }
    for (const id of wanted) {
      if (this.subs.has(id)) continue
      this.subs.set(
        id,
        this.deps.hub.subscribe(id, (frame) => {
          if (frame.event !== 'message' || frame.data.action !== 'created') return
          this.deps.turns.onMessage(id, frame.data.message).catch((err: unknown) =>
            console.error('[coworkers] a co-worker trigger failed', { coworkerId: id, messageId: frame.data.message.id, err }),
          )
        }),
      )
    }
  }

  stop(): void {
    this.stopped = true
    for (const unsubscribe of this.subs.values()) unsubscribe()
    this.subs.clear()
  }
}
