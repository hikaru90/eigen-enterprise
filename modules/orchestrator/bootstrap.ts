import type { AllowlistStore, SessionStore } from '../chat-gateway/stores'
import type { TelegramGateway } from '../chat-gateway/telegram'
import type { WiredKernel } from '../index'
import {
  agentAdminManifest,
  AGENT_ADMIN_MODULE_ID,
  createAgentAdminTools,
} from '$lib/kernel/agent-admin'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import type { LlmCompleteFn } from '$lib/kernel/engines/builtin-json'
import type { AppDatabase } from '$lib/server/db/context'
import { createChatGateway } from '../chat-gateway/index'
import { bootstrapKernel, registerModuleTools } from '../index'
import { createAllowlistAdminTools } from './allowlist-tools'
import {
  buildOrchestratorEngine,
  orchestratorAgentConfig,
  OrchestratorBrain,
  ORCHESTRATOR_PRINCIPAL,
} from './brain'
import { createTelegramLoop, type TelegramLoopHandle } from './loop'

/**
 * ACTIVATION SEEDING (Phase 0): there is no admin UI yet. Deployers activate
 * the chat-gateway module (and any other module) directly in SQL, e.g.:
 *
 *   INSERT INTO kernel_module_activations (module_id, active, updated_at)
 *   VALUES ('chat-gateway', true, now())
 *   ON CONFLICT (module_id) DO UPDATE SET active = true, updated_at = now();
 *
 * While 'chat-gateway' is inactive, bootstrapOrchestrator skips the gateway
 * and poll loop entirely (fail closed) and requires no TELEGRAM_BOT_TOKEN.
 * Once active, the token is mandatory — the gateway cannot start without it.
 */

export type OrchestratorStatus = {
  chatGateway: 'active' | 'inactive'
  loopRunning: boolean
}

export type OrchestratorBoot = {
  kernel: WiredKernel
  /** The harness runtime hosting the orchestrator as one agent config. */
  runtime: AgentRuntime
  brain: OrchestratorBrain
  /** Null while the chat-gateway module is inactive. */
  gateway: TelegramGateway | null
  allowlist: AllowlistStore | null
  sessions: SessionStore | null
  /** Null while the chat-gateway module is inactive. */
  loop: TelegramLoopHandle | null
  status(): OrchestratorStatus
}

export type OrchestratorBootOptions = {
  /** Process env (or any env record); TELEGRAM_BOT_TOKEN is required once chat-gateway is active. */
  env: Record<string, string | undefined>
  /** Defaults to the process-wide kernel singleton (tests inject an in-memory kernel). */
  kernel?: WiredKernel
  /** Defaults to a pooled app DB handle (kernel/gateway tables are not RLS-scoped). */
  db?: AppDatabase
  /** Start the Telegram poll loop immediately (default true; tests pass false). */
  startLoop?: boolean
  /** Overrides the harness runtime (tests inject an in-memory one). */
  runtime?: AgentRuntime
  /** Overrides the orchestrator engine's completion call (tests inject fakes; never a real LLM). */
  complete?: LlmCompleteFn
}

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
 * Composes the Phase-1b path: kernel → harness runtime (orchestrator as one
 * AgentConfig on the builtin-json engine) → chat gateway → Telegram poll
 * loop. The chat-gateway manifest and its tools (status + owner-only
 * allowlist admin) are registered here through the kernel's validated
 * registration path; the agent admin surface (agent.list/enable/disable) is
 * registered next to them.
 */
export async function bootstrapOrchestrator(
  options: OrchestratorBootOptions,
): Promise<OrchestratorBoot> {
  const kernel = options.kernel ?? bootstrapKernel()

  // The harness: orchestrator is demoted to one config on the shared runtime.
  const runtime =
    options.runtime ??
    new AgentRuntime({
      registry: kernel.registry,
      isToolActive: (name) => kernel.modules.isToolActive(name),
      eventSink: kernel.eventSink,
      rolesFor: () => ORCHESTRATOR_PRINCIPAL.roles,
    })
  runtime.registerEngine(
    'builtin-json',
    buildOrchestratorEngine(options.complete === undefined ? {} : { complete: options.complete }),
  )
  runtime.registerAgent(orchestratorAgentConfig({ spendCapUsd: spendCapUsdFromEnv(options.env) }))

  const brain = new OrchestratorBrain({ runtime })

  // AGENT ADMIN REGISTRATION (flagged edit, phase-1b): register the 'agent'
  // module self-seeded active, next to the kernel admin pattern — the admin
  // surface cannot gate on the runtime it administers (bootstrap deadlock).
  await kernel.activations.set(AGENT_ADMIN_MODULE_ID, true)
  kernel.modules.register(agentAdminManifest)
  registerModuleTools(kernel.registry, kernel.modules, createAgentAdminTools({ runtime }))

  const gatewayActive = await kernel.activations.get('chat-gateway')
  if (!gatewayActive) {
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

  const db = options.db ?? (await pooledDb())
  const gatewayBoot = createChatGateway({
    env: options.env,
    db,
    eventSink: kernel.eventSink,
    brain,
  })

  kernel.modules.register(gatewayBoot.manifest)
  registerModuleTools(kernel.registry, kernel.modules, [
    gatewayBoot.statusTool,
    ...createAllowlistAdminTools(gatewayBoot.allowlist),
  ])

  const loop = createTelegramLoop({ gateway: gatewayBoot.gateway })
  if (options.startLoop !== false) loop.start()

  return {
    kernel,
    runtime,
    brain,
    gateway: gatewayBoot.gateway,
    allowlist: gatewayBoot.allowlist,
    sessions: gatewayBoot.sessions,
    loop,
    status: () => ({
      chatGateway: 'active',
      loopRunning: loop.running,
    }),
  }
}

/**
 * Background DB handle: a drizzle instance over the app pool. The poll loop
 * runs outside any request/ALS context, so request-scoped getDb() is not
 * available; kernel + gateway tables carry no RLS, while per-user tools
 * (memory, email) establish their own scoped sessions internally.
 */
async function pooledDb(): Promise<AppDatabase> {
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  return createScopedDrizzle(appSql)
}
