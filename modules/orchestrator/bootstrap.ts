import type { OnboardingFactsResolver } from './onboarding-context'
import {
  agentAdminManifest,
  AGENT_ADMIN_MODULE_ID,
  createAgentAdminTools,
} from '$lib/kernel/agent-admin'
import type { LoopEngine } from '$lib/kernel/engine'
import type { AllowlistStore, SessionStore } from '$lib/kernel/gateway'
import { InMemoryJourneyStore, type JourneyStore } from '$lib/kernel/playbook'
import { registerModuleTools, type WiredKernel } from '$lib/kernel/wiring'
import { OrchestratorBrain } from './brain'
import { JourneyAwareAgentRuntime } from './brain'
import {
  orchestratorAgentConfig,
  ORCHESTRATOR_PRINCIPAL,
  WEBSITE_FOUNDING_JOURNEY,
} from './brain'
import { createTelegramLoop, type TelegramGatewayLike, type TelegramLoopHandle } from './loop'
import { connectedReposPort, type ConnectedReposPort } from './repos-context'

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
  /** The harness runtime hosting the orchestrator as one agent config. */
  runtime: JourneyAwareAgentRuntime
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
  /** Overrides the harness runtime (tests inject an in-memory one). */
  runtime?: JourneyAwareAgentRuntime
  /** Environment for boot-time config (spend cap). Defaults to process.env. */
  env?: Record<string, string | undefined>
  /**
   * The loop engines the composition root hosts: 'durable' (the orchestrator's
   * only engine, composed in $lib/server/agent) is required; others are optional. Injected here — the
   * orchestrator must not import other modules directly (boundary guard).
   */
  engines?: Array<[string, LoopEngine]>
  /**
   * Durable journey state for the website-founding journey. Defaults to the
   * in-memory store (same v0 debt as engine sessions: a restart loses an
   * in-flight journey); the composition root injects the DB-backed store.
   */
  journeys?: JourneyStore
  /** Assisted-onboarding facts (DB-backed in the composition root). Absent = hand-off never active. */
  onboardingFacts?: OnboardingFactsResolver
  /**
   * The "Connected GitHub repos" block's data. Defaults to the port modules/index
   * registered while building the kernel (provideConnectedReposPort).
   */
  connectedRepos?: ConnectedReposPort
}

const connectedReposOption = (port: ConnectedReposPort | null) => (port ? { connectedRepos: port } : {})

/**
 * Orchestrator spend cap. EE_HARNESS_SPEND_CAP_USD, when present, must parse
 * to a finite non-negative number — no silent fallbacks: a malformed value
 * fails the boot loud. Absent/empty means uncapped.
 */
function spendCapUsdFromEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.EE_HARNESS_SPEND_CAP_USD
  if (raw === undefined || raw.trim() === '') return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `EE_HARNESS_SPEND_CAP_USD must be a finite non-negative number, got: "${raw}"`,
    )
  }
  return parsed
}

/**
 * Composes the orchestrator stage of the Phase-1b path: kernel → harness
 * runtime (orchestrator as one AgentConfig on the durable engine) → chat
 * gateway → Telegram poll loop. The chat-gateway surface itself (construction,
 * manifest + tool registration) is wired by the composition root's
 * `bootstrapChatGateway` stage, injected here as `wireGateway` so the
 * orchestrator imports only the kernel — no cross-module wiring. The agent
 * admin surface (agent.list/enable/disable) is registered here next to the
 * runtime it administers.
 */
export async function bootstrapOrchestrator(
  kernel: WiredKernel,
  wireGateway: (brain: OrchestratorBrain) => Promise<OrchestratorGatewayStage | null>,
  options: OrchestratorBootOptions = {},
): Promise<OrchestratorBoot> {
  const env = options.env ?? process.env

  // The harness: orchestrator is demoted to one config on the shared runtime.
  // The runtime is journey-aware: it drives the website-founding journey
  // around dispatch for the orchestrator agent only (pure passthrough for
  // every other agent). Journeys default in-memory; boot.ts injects the
  // DB-backed store for production.
  const runtime =
    options.runtime ??
    new JourneyAwareAgentRuntime({
      registry: kernel.registry,
      isToolActive: (name) => kernel.modules.isToolActive(name),
      eventSink: kernel.eventSink,
      rolesFor: () => ORCHESTRATOR_PRINCIPAL.roles,
      journeys: options.journeys ?? new InMemoryJourneyStore(),
      spec: WEBSITE_FOUNDING_JOURNEY,
      ...(options.onboardingFacts ? { onboardingFacts: options.onboardingFacts } : {}),
      ...connectedReposOption(options.connectedRepos ?? connectedReposPort()),
    })
  for (const [id, engine] of options.engines ?? []) {
    runtime.registerEngine(id, engine)
  }
  // The orchestrator has exactly one engine. Boot fails loud without it — never
  // a chat that discovers the gap on its first turn.
  if (!(options.engines ?? []).some(([id]) => id === 'durable')) {
    throw new Error("bootstrapOrchestrator: the 'durable' loop engine must be injected via options.engines")
  }
  runtime.registerAgent(orchestratorAgentConfig({ spendCapUsd: spendCapUsdFromEnv(env) }))

  const brain = new OrchestratorBrain({ runtime })

  // AGENT ADMIN REGISTRATION (flagged edit, phase-1b): register the 'agent'
  // module self-seeded active, next to the kernel admin pattern — the admin
  // surface cannot gate on the runtime it administers (bootstrap deadlock).
  await kernel.activations.set(AGENT_ADMIN_MODULE_ID, true)
  kernel.modules.register(agentAdminManifest)
  registerModuleTools(kernel.registry, kernel.modules, createAgentAdminTools({ runtime }))

  const stage = await wireGateway(brain)
  if (!stage) {
    return {
      kernel,
      runtime,
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
    runtime,
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
