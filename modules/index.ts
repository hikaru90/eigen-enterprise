import { StaticApprovalPolicy, type ApprovalStore } from '$lib/kernel/approvals'
import {
  DbActivationStore,
  DbAgentSessionLog,
  DbApprovalStore,
  DbEventSink,
  DbPrincipalStore,
  type DbHandle,
} from '$lib/kernel/db-stores'
import type { EventSink } from '$lib/kernel/events'
import { CHAT_GATEWAY_MODULE_ID, type Brain } from '$lib/kernel/gateway'
import { ModuleRegistry, type ActivationStore } from '$lib/kernel/modules'
import type { PrincipalStore } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { AgentSessionLog } from '$lib/kernel/session-log'
import { GitCommitter, type VcsCommitter } from '$lib/kernel/vcs'
import {
  registerModuleTools,
  type WiredKernel,
} from '$lib/kernel/wiring'
import type { AppDatabase } from '$lib/server/db/context'
import { brandManifest } from './brand/manifest'
import { createBrandTools } from './brand/tools'
import { DbAllowlistStore } from './chat-gateway/db-stores'
import { createChatGateway, type ChatGatewayBoot } from './chat-gateway/index'
import { telegramClientFromEnv } from './chat-gateway/telegram'
import { createDevAgentEngine, devAgentManifest } from './dev-agent'
import { createDevAgentTools, type DevAgentEngine } from './dev-agent/tools'
import { emailManifest } from './email/manifest'
import { createEmailTools } from './email/tools'
import { memoryManifest } from './memory/manifest'
import { createMemoryTools } from './memory/tools'
import { createAllowlistAdminTools } from './orchestrator/allowlist-tools'
import { createRecapModule, type RecapBoot } from './recap'
import { RECAP_MODULE_ID } from './recap/types'
import { createRepoEngine } from './repo/index'
import { repoManifest } from './repo/manifest'
import { createRepoTools, type RepoEngine } from './repo/tools'

export type { RecapBoot } from './recap'
import { websiteManifest } from './website/manifest'
import { createWebsiteTools } from './website/tools'

export { registerModuleTools, type WiredKernel } from '$lib/kernel/wiring'
export type { ChatGatewayBoot } from './chat-gateway/index'

/** The static module surface of this eigenEnterprise instance. */
export const moduleManifests = [
  memoryManifest,
  emailManifest,
  websiteManifest,
  devAgentManifest,
  brandManifest,
  repoManifest,
] as const

/** Tools that always require an approval decision before first execution. */
export const APPROVAL_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  'email.send_mail',
  // Phase-2c (G8/D5): guideline-set activation is a strategic brand decision —
  // human-admin principal AND an explicit approval decision.
  'brand.set_activate',
  // Phase-2d M5 (V9): visual-set activation is THE strategic go-live moment —
  // once approved, the set's tokens apply globally to every user-facing
  // surface (root :root override, public hero, shader tints).
  'brand.visual_set_activate',
  // Website founding journey: publishing is a public, owner-owned act — the
  // journey's website.publish_page artifacts gate here (approval_required),
  // surfacing as the chatbox approval card until the owner decides.
  'website.publish_page',
  // Phase-3 M2: the agent's repo hands land on the instance repo here —
  // merging agent work into the company repo is an owner decision made in chat.
  'repo.merge',
  // Phase-3 one-agent: module lifecycle levers are owner decisions made in
  // chat — the agent calls kernel.module_activate/deactivate, the gate halts
  // until the owner's conversational yes (kernel.approvals_decide).
  'kernel.module_activate',
  'kernel.module_deactivate',
])

export type BootstrapKernelOptions = {
  /** Overrides the lazy per-request `getDb()` handle (tests inject fakes). */
  db?: DbHandle
  activations?: ActivationStore
  eventSink?: EventSink
  approvalStore?: ApprovalStore
  principals?: PrincipalStore
  /** Overrides the DB-backed agent session log (tests inject in-memory). */
  sessionLog?: AgentSessionLog
  /** Defaults to a real GitCommitter; pass null to disable autocommit. */
  vcsCommitter?: VcsCommitter | null
  /** Overrides the dev-agent engine (tests inject one with fake runners). */
  devAgentEngine?: DevAgentEngine
  /** Overrides the repo engine (tests inject one with fake runners). */
  repoEngine?: RepoEngine
}

/**
 * Build a fully wired kernel. Defaults are DB-backed (kernel_* tables) with a
 * lazy db provider so nothing connects until an operation actually runs;
 * inject fakes for in-memory use.
 */
export function buildKernel(options: BootstrapKernelOptions = {}): WiredKernel {
  const db: DbHandle =
    options.db ??
    (async () => {
      // Kernel tables are company-level (no RLS, no tenant scoping): use the
      // request-scoped handle when one exists (MCP/web request paths), and a
      // pooled app handle otherwise so background consumers (orchestrator
      // poll loop, which runs outside any request/ALS context) still get a
      // working audit/activation/approval path. Per-user tools keep their own
      // scoped sessions regardless of which handle the kernel stores use.
      const { appDbAsyncLocal, appSql, createScopedDrizzle } = await import('$lib/server/db')
      const scoped = appDbAsyncLocal.getStore()
      if (scoped) return scoped
      return createScopedDrizzle(appSql)
    })

  const activations = options.activations ?? new DbActivationStore(db)
  const eventSink = options.eventSink ?? new DbEventSink(db)
  const approvalStore = options.approvalStore ?? new DbApprovalStore(db)
  const principals = options.principals ?? new DbPrincipalStore(db)
  const sessionLog = options.sessionLog ?? new DbAgentSessionLog(db)
  const vcsCommitter = options.vcsCommitter === undefined ? new GitCommitter() : options.vcsCommitter

  const modules = new ModuleRegistry(activations)
  for (const manifest of moduleManifests) modules.register(manifest)

  const registry = new KernelRegistry({
    eventSink,
    activationStore: activations,
    approvalPolicy: new StaticApprovalPolicy(APPROVAL_REQUIRED_TOOLS),
    approvalStore,
    vcsCommitter,
  })

  registerModuleTools(registry, modules, [
    ...createMemoryTools(),
    ...createEmailTools(),
    ...createWebsiteTools(),
    ...createDevAgentTools({
      engine: options.devAgentEngine ?? createDevAgentEngine({ eventSink }),
    }),
    ...createBrandTools(),
    ...createRepoTools({
      engine: options.repoEngine ?? createRepoEngine({ eventSink }),
    }),
  ])

  return {
    registry,
    modules,
    activations,
    principals,
    approvals: approvalStore,
    eventSink,
    sessionLog,
  }
}

let singleton: WiredKernel | null = null

/** Process-wide kernel (first call wins; later options are ignored). */
export function bootstrapKernel(options: BootstrapKernelOptions = {}): WiredKernel {
  if (!singleton) singleton = buildKernel(options)
  return singleton
}

export type ChatGatewayBootOptions = {
  /** Process env (or any env record); TELEGRAM_BOT_TOKEN is required once chat-gateway is active. */
  env: Record<string, string | undefined>
  /** Overrides the pooled app DB handle (tests inject fakes). */
  db?: AppDatabase
}

/**
 * Chat-gateway boot stage of the Phase-0 path (kernel → orchestrator brain →
 * chat gateway): while the module is inactive this returns null and needs no
 * TELEGRAM_BOT_TOKEN; once active the token is mandatory (fail loud). The
 * gateway manifest and its tools (status + owner-only allowlist admin) are
 * registered here through the kernel's validated registration path.
 */
export async function bootstrapChatGateway(
  kernel: WiredKernel,
  brain: Brain,
  options: ChatGatewayBootOptions,
): Promise<ChatGatewayBoot | null> {
  if (!(await kernel.activations.get(CHAT_GATEWAY_MODULE_ID))) return null

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

  return gatewayBoot
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

// ─── AGENT-C ADDITIVE BLOCK: recap module boot stage (daily owner recap) ─────
// Follows the bootstrapChatGateway pattern exactly: activation-gated (fail
// closed, needs nothing while 'recap' is inactive), manifest + tool registered
// through the kernel's validated registerModuleTools path, deps injected with
// no new side doors (Telegram client + allowlist store reused from
// chat-gateway, event sink from the kernel). Scheduling stays in-module
// (modules/recap/schedule.ts); the caller owns tick cadence:
//   const boot = await bootstrapRecap(kernel, { env: process.env })
//   if (boot) setInterval(() => boot.scheduler.maybeRun(new Date()), 5 * 60_000)
// The scheduler self-guards to one run per UTC day and retries the same day
// after a failed delivery.

export type RecapBootOptions = {
  /** Process env (or any env record); TELEGRAM_BOT_TOKEN is required once recap is active. */
  env: Record<string, string | undefined>
  /** Overrides the pooled app DB handle (tests inject fakes). */
  db?: AppDatabase
}

/**
 * Recap boot stage: while the module is inactive this returns null and needs
 * no TELEGRAM_BOT_TOKEN; once active the token is mandatory (fail loud).
 */
export async function bootstrapRecap(
  kernel: WiredKernel,
  options: RecapBootOptions,
): Promise<RecapBoot | null> {
  if (!(await kernel.activations.get(RECAP_MODULE_ID))) return null

  const db = options.db ?? (await pooledDb())
  const recapBoot = createRecapModule(
    {
      db,
      telegram: telegramClientFromEnv(options.env),
      allowlist: new DbAllowlistStore(db),
      eventSink: kernel.eventSink,
    },
    { isActive: () => kernel.activations.get(RECAP_MODULE_ID) },
  )

  kernel.modules.register(recapBoot.manifest)
  registerModuleTools(kernel.registry, kernel.modules, [recapBoot.runNowTool])

  return recapBoot
}
// ─── END AGENT-C ADDITIVE BLOCK ──────────────────────────────────────────────
