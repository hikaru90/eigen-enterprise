import type { AllowlistStore, SessionStore } from '../chat-gateway/stores'
import type { TelegramGateway } from '../chat-gateway/telegram'
import type { WiredKernel } from '../index'
import type { AppDatabase } from '$lib/server/db/context'
import { createChatGateway } from '../chat-gateway/index'
import { bootstrapKernel, registerModuleTools } from '../index'
import { createAllowlistAdminTools } from './allowlist-tools'
import { OrchestratorBrain } from './brain'
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
}

/**
 * Composes the Phase-0 path: kernel → orchestrator brain → chat gateway →
 * Telegram poll loop. The chat-gateway manifest and its tools (status +
 * owner-only allowlist admin) are registered here through the kernel's
 * validated registration path.
 */
export async function bootstrapOrchestrator(
  options: OrchestratorBootOptions,
): Promise<OrchestratorBoot> {
  const kernel = options.kernel ?? bootstrapKernel()

  const brain = new OrchestratorBrain({ registry: kernel.registry, modules: kernel.modules })

  const gatewayActive = await kernel.activations.get('chat-gateway')
  if (!gatewayActive) {
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
