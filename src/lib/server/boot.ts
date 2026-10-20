import type { ChatGatewayBoot, RecapBoot } from '../../../modules/index'
import { building } from '$app/environment'
import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { DbJourneyStore, type JourneyStore } from '$lib/kernel/playbook'
import type { WiredKernel } from '$lib/kernel/wiring'
import { createDurableEngine } from '$lib/server/agent/durable-engine'
import { piEngine } from '../../../modules/orchestrator/dev-agent'
import {
  bootstrapChatGateway,
  bootstrapRecap,
  buildKernel,
  ensureSystemModulesActive,
  type BootstrapKernelOptions,
} from '../../../modules/index'
import {
  bootstrapOrchestrator,
  type OrchestratorBoot,
  type OrchestratorGatewayStage,
  type OrchestratorStatus,
} from '../../../modules/orchestrator/bootstrap'
import { ORCHESTRATOR_PERSONA_PROMPT } from '../../../modules/orchestrator/brain'

/**
 * Startup composition root (phase-1b): kernel → orchestrator (the harness
 * runtime, hosting the dev-agent `pi` engine via the orchestrator's engine
 * injection seam) → chat gateway + Telegram poll loop → recap module + its
 * scheduler tick.
 *
 * `bootApp()` is single-flight per process: the first call composes the boot
 * and memoizes the promise; every later call returns the same boot regardless
 * of options (first call wins, mirroring modules/index bootstrapKernel). A
 * FAILED boot is never cached — the rejection clears the memo so the next
 * call re-attempts a full, fresh composition (pinned by boot.spec.ts).
 *
 * HMR caveat (dev only): Vite may re-evaluate this module on edit, resetting
 * the memo — the next request then composes a fresh boot. Production
 * processes boot exactly once. The recap tick timer is guarded on globalThis
 * (cleared and re-armed per composition), so HMR re-compositions converge to
 * exactly ONE live timer pointing at the newest boot.
 *
 * Env is injectable and defaults to process.env; no other direct process.env
 * read happens here. Fail-loud rules are inherited from the stages: an active
 * chat-gateway without TELEGRAM_BOT_TOKEN aborts this boot (chatGatewayEnv),
 * while an inactive one needs no token and leaves the gateway/loop null.
 */

export type AppBootOptions = {
  /** Env for boot-time config (spend cap, gateway token rule). Defaults to process.env. */
  env?: Record<string, string | undefined>
  /** Overrides buildKernel (tests inject an in-memory kernel). */
  buildKernel?: (options?: BootstrapKernelOptions) => WiredKernel
  /** Overrides bootstrapOrchestrator (tests inject a fake stage). */
  bootstrapOrchestrator?: typeof bootstrapOrchestrator
  /** Overrides bootstrapChatGateway (tests inject a fake/null stage). */
  bootstrapChatGateway?: typeof bootstrapChatGateway
  /** Overrides bootstrapRecap (tests inject a fake/null stage). */
  bootstrapRecap?: typeof bootstrapRecap
  /** Overrides the DB-backed journey store (tests inject an in-memory one). */
  journeys?: JourneyStore
  /** Recap scheduler tick (default: start, 5-minute cadence; tests opt out). */
  recap?: { startTick?: boolean; intervalMs?: number }
}

export type AppBootStatus = {
  orchestrator: OrchestratorStatus
  /** True once the chat-gateway stage registered its manifest + tools on the kernel. */
  gatewayBooted: boolean
  /** True once the recap stage registered its manifest + tool on the kernel. */
  recapBooted: boolean
}

export type AppBoot = {
  kernel: WiredKernel
  orchestrator: OrchestratorBoot
  /** The full chat-gateway boot (manifest, tools, client) or null while inactive. */
  gateway: ChatGatewayBoot | null
  /** The recap module boot (scheduler included) or null while inactive. */
  recap: RecapBoot | null
  /**
   * Durable journey store (the same instance the orchestrator runtime drives).
   * Exposed for onboarding: the founding interview opens its journey here.
   */
  journeys: JourneyStore
  status(): AppBootStatus
}

let bootPromise: Promise<AppBoot> | null = null

/** Lazy pooled-handle pattern of the kernel stores (request-scoped when inside ALS, pooled otherwise). */
async function kernelDbHandle() {
  const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
  const scoped = appDbAsyncLocal.getStore()
  if (scoped) return scoped
  return createScopedDrizzle(appSql)
}

/**
 * globalThis guard: across HMR re-evaluations only one recap tick may live.
 * A re-composition clears the previous timer and re-arms against the new boot.
 */
const recapTickHost = globalThis as { __eeRecapTick?: ReturnType<typeof setInterval> }

/** Tick cadence: the scheduler self-guards to one run per UTC day. */
function startRecapTick(recap: RecapBoot, intervalMs: number): void {
  if (recapTickHost.__eeRecapTick) clearInterval(recapTickHost.__eeRecapTick)
  recapTickHost.__eeRecapTick = setInterval(() => {
    void recap.scheduler.maybeRun(new Date()).catch((err: unknown) => {
      // The scheduler retries the same day; never let a tick kill the process.
      console.error('[recap] scheduler tick failed', err)
    })
  }, intervalMs)
}

/** Process-wide app boot (first call wins; later options are ignored). */
export function bootApp(options: AppBootOptions = {}): Promise<AppBoot> {
  bootPromise ??= composeApp(options).catch((err: unknown) => {
    // A failed boot must not stick: clear the memo so the next call re-composes.
    bootPromise = null
    throw err
  })
  return bootPromise
}

async function composeApp(options: AppBootOptions): Promise<AppBoot> {
  const env = options.env ?? process.env
  const buildKernelFn = options.buildKernel ?? buildKernel
  const orchestratorFn = options.bootstrapOrchestrator ?? bootstrapOrchestrator
  const gatewayFn = options.bootstrapChatGateway ?? bootstrapChatGateway
  const recapFn = options.bootstrapRecap ?? bootstrapRecap

  const kernel = buildKernelFn()
  // The kernel admin surface (kernel.module_list / module_activate / approvals)
  // is part of the web server's kernel, not only the CLI's: the orchestrator's
  // remediation path (and its tool-error prompt) depends on it.
  await registerAdminTools(kernel, { db: kernelDbHandle })
  // Hosting, GitHub and email are the company's system modules: on from the first boot.
  await ensureSystemModulesActive(kernel)

  // Durable journey state: DB-backed via the same lazy pooled-handle pattern
  // the kernel stores use (request-scoped when inside ALS, pooled otherwise).
  const journeys: JourneyStore = options.journeys ?? new DbJourneyStore(kernelDbHandle)

  let gatewayBoot: ChatGatewayBoot | null = null
  const wireGateway = async (
    brain: Parameters<typeof bootstrapChatGateway>[1],
  ): Promise<OrchestratorGatewayStage | null> => {
    const boot = await gatewayFn(kernel, brain, { env })
    gatewayBoot = boot
    // Adapt the stage's real boot shape down to the kernel gateway port the
    // orchestrator consumes (TelegramGatewayLike + allowlist + sessions).
    return boot === null
      ? null
      : { gateway: boot.gateway, allowlist: boot.allowlist, sessions: boot.sessions }
  }

  // The durable engine is the orchestrator's only engine: the harness opens at
  // boot so turns a restart interrupted resume now.
  const durable = createDurableEngine({ env, instructions: ORCHESTRATOR_PERSONA_PROMPT })
  const orchestrator = await orchestratorFn(kernel, wireGateway, {
    env,
    engines: [
      ['pi', piEngine],
      ['durable', durable.engine],
    ],
    journeys,
    // Assisted onboarding facts (lazy DB import, like the journey store: boot
    // itself stays DB-free).
    onboardingFacts: async (llmUserId) =>
      (await import('$lib/server/onboarding/assisted')).onboardingFactsFor(llmUserId),
  })
  // Warm-up (crash-resume): open the harness now, not on the first chat turn.
  if (!building) {
    void durable.warmUp().catch((err: unknown) => {
      console.error('[durable] could not open the agent harness at boot:', err)
    })
  }

  // Recap module (agent C's stage, previously without a caller): activation-
  // gated, registers manifest + run_now tool through the kernel's validated
  // path. The scheduler tick lives here (composition root owns cadence).
  const recap = await recapFn(kernel, { env })
  if (recap && (options.recap?.startTick ?? true)) {
    startRecapTick(recap, options.recap?.intervalMs ?? 5 * 60_000)
  }

  return {
    kernel,
    orchestrator,
    gateway: gatewayBoot,
    recap,
    journeys,
    status: () => ({
      orchestrator: orchestrator.status(),
      gatewayBooted: gatewayBoot !== null,
      recapBooted: recap !== null,
    }),
  }
}
