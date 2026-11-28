import type { StreamFrame } from '../../../../modules/messages/hub'
import type { CoworkerTurns, HeardMessage, TurnPrompts } from './turns'
import type { AgentConfig, CoworkerSource } from '$lib/kernel/agent'
import { coworkerPrincipal } from '$lib/kernel/principals'
import type { SlotSource } from '$lib/server/llm/slots'
import { presentCoworker, type CoworkerView } from './service'

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
    // null = eigenInference: the pool's chat pick (the company's chat slot), never a stored pick.
    ...(view.modelId !== null ? { modelId: view.modelId } : {}),
    task: 'coworkers.turn',
    actsAs: {
      kind: 'self',
      principalFor: () => coworkerPrincipal(view.id, view.agentId),
      dailySpendCapUsd: view.dailyCapUsd,
    },
    enabled: true,
  }
}

/**
 * The agents as the company's AI source runs them, read before every turn: on eigenInference a
 * co-worker's stored pick (a Sonnet chosen before, say) no longer runs (wish cd140a7a, 2026-11-28).
 */
export function coworkerAgentSource(deps: {
  listEnabled: () => Promise<CoworkerView[]>
  prompts: TurnPrompts
  aiSource: () => Promise<SlotSource>
}): CoworkerSource {
  return {
    listAgentConfigs: async () => {
      const [views, source] = await Promise.all([deps.listEnabled(), deps.aiSource()])
      return views.map((view) => coworkerAgentConfig(presentCoworker(view, source), deps.prompts))
    },
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
 *
 * C7: the same frames go to the event sources (`events`, e.g. ChannelMessageSource): a message
 * that does not ask for a turn may still be an event a co-worker notices. Every co-worker's
 * frame of a message is handed over; the source routes each message once.
 */
export class CoworkerTriggerListener {
  private readonly subs = new Map<string, () => void>()
  private stopped = false

  constructor(
    private readonly deps: {
      hub: MessageFrames
      listEnabled: () => Promise<CoworkerView[]>
      turns: Pick<CoworkerTurns, 'onMessage'>
      events?: { onMessage(message: HeardMessage): Promise<unknown> }
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
          this.deps.events?.onMessage(frame.data.message).catch((err: unknown) =>
            console.error('[coworkers] an event source failed', { heardBy: id, messageId: frame.data.message.id, err }),
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
