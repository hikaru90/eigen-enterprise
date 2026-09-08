import type { ChatGatewayBoot } from '../../../modules/chat-gateway/index'
import type { WiredKernel } from '$lib/kernel/wiring'
import { piEngine } from '../../../modules/dev-agent'
import {
  bootstrapChatGateway,
  buildKernel,
  type BootstrapKernelOptions,
} from '../../../modules/index'
import {
  bootstrapOrchestrator,
  type OrchestratorBoot,
  type OrchestratorGatewayStage,
  type OrchestratorStatus,
} from '../../../modules/orchestrator/bootstrap'

/**
 * Startup composition root (phase-1b): kernel → orchestrator (the harness
 * runtime, hosting the dev-agent `pi` engine via the orchestrator's engine
 * injection seam) → chat gateway + Telegram poll loop.
 *
 * `bootApp()` is single-flight per process: the first call composes the boot
 * and memoizes the promise; every later call returns the same boot regardless
 * of options (first call wins, mirroring modules/index bootstrapKernel). A
 * FAILED boot is never cached — the rejection clears the memo so the next
 * call re-attempts a full, fresh composition (pinned by boot.spec.ts).
 *
 * HMR caveat (dev only): Vite may re-evaluate this module on edit, resetting
 * the memo — the next request then composes a fresh boot. Production
 * processes boot exactly once.
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
}

export type AppBootStatus = {
  orchestrator: OrchestratorStatus
  /** True once the chat-gateway stage registered its manifest + tools on the kernel. */
  gatewayBooted: boolean
}

export type AppBoot = {
  kernel: WiredKernel
  orchestrator: OrchestratorBoot
  /** The full chat-gateway boot (manifest, tools, client) or null while inactive. */
  gateway: ChatGatewayBoot | null
  status(): AppBootStatus
}

let bootPromise: Promise<AppBoot> | null = null

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

  const kernel = buildKernelFn()

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

  const orchestrator = await orchestratorFn(kernel, wireGateway, {
    env,
    engines: [['pi', piEngine]],
  })

  return {
    kernel,
    orchestrator,
    gateway: gatewayBoot,
    status: () => ({ orchestrator: orchestrator.status(), gatewayBooted: gatewayBoot !== null }),
  }
}
