import type { AllowlistStore, SessionStore } from '$lib/kernel/gateway'
import type { WiredKernel } from '$lib/kernel/wiring'
import { OrchestratorBrain } from './brain'
import { createTelegramLoop, type TelegramGatewayLike, type TelegramLoopHandle } from './loop'

/**
 * ACTIVATION SEEDING (Phase 0): there is no admin UI yet. Deployers activate
 * the chat-gateway module (and any other module) directly in SQL, e.g.:
 *
 *   INSERT INTO kernel_module_activations (module_id, active, updated_at)
 *   VALUES ('chat-gateway', true, now())
 *   ON CONFLICT (module_id) DO UPDATE SET active = true, updated_at = now();
 *
 * While 'chat-gateway' is inactive, the composition root's
 * bootstrapChatGateway stage returns null, so bootstrapOrchestrator skips the
 * gateway and poll loop entirely (fail closed) and requires no
 * TELEGRAM_BOT_TOKEN. Once active, the token is mandatory — the gateway
 * cannot start without it.
 */

export type OrchestratorStatus = {
  chatGateway: 'active' | 'inactive'
  loopRunning: boolean
}

/** Gateway pieces bootstrapOrchestrator needs once the gateway stage ran. */
export type OrchestratorGatewayStage = {
  gateway: TelegramGatewayLike
  allowlist: AllowlistStore
  sessions: SessionStore
}

export type OrchestratorBoot = {
  kernel: WiredKernel
  brain: OrchestratorBrain
  /** Null while the chat-gateway module is inactive. */
  gateway: TelegramGatewayLike | null
  allowlist: AllowlistStore | null
  sessions: SessionStore | null
  /** Null while the chat-gateway module is inactive. */
  loop: TelegramLoopHandle | null
  status(): OrchestratorStatus
}

export type OrchestratorBootOptions = {
  /** Start the Telegram poll loop immediately (default true; tests pass false). */
  startLoop?: boolean
}

/**
 * Composes the orchestrator stage of the Phase-0 path: kernel → orchestrator
 * brain → chat gateway → Telegram poll loop. The chat-gateway surface itself
 * (construction, manifest + tool registration) is wired by the composition
 * root's `bootstrapChatGateway` stage, injected here as `wireGateway` so the
 * orchestrator imports only the kernel — no cross-module wiring.
 */
export async function bootstrapOrchestrator(
  kernel: WiredKernel,
  wireGateway: (brain: OrchestratorBrain) => Promise<OrchestratorGatewayStage | null>,
  options: OrchestratorBootOptions = {},
): Promise<OrchestratorBoot> {
  const brain = new OrchestratorBrain({ registry: kernel.registry, modules: kernel.modules })

  const stage = await wireGateway(brain)
  if (!stage) {
    return {
      kernel,
      brain,
      gateway: null,
      allowlist: null,
      sessions: null,
      loop: null,
      status: () => ({ chatGateway: 'inactive', loopRunning: false }),
    }
  }

  const loop = createTelegramLoop({ gateway: stage.gateway })
  if (options.startLoop !== false) loop.start()

  return {
    kernel,
    brain,
    gateway: stage.gateway,
    allowlist: stage.allowlist,
    sessions: stage.sessions,
    loop,
    status: () => ({
      chatGateway: 'active',
      loopRunning: loop.running,
    }),
  }
}
