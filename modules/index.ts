import type { CallContextPort, CallLogPort } from './calls/context-port'
import type { CallsHub } from './calls/hub'
import type { CallsService } from './calls/service'
import type { MailDomain } from './domains/view'
import type { MessagesDeps } from './messages/service'
import type { DriveSourcePort } from './repos/drive-port'
import { join } from 'node:path'
import type { BoughtDomain } from '$lib/domains/contract'
import { CachedActivationStore } from '$lib/kernel/activation-cache'
import {
  ModeAwareApprovalPolicy,
  type ApprovalModeStore,
  type ApprovalStore,
} from '$lib/kernel/approvals'
import {
  DbActivationStore,
  DbApprovalModeStore,
  DbApprovalStore,
  DbEventSink,
  DbPrincipalStore,
  notifyActivationChange,
  type DbHandle,
} from '$lib/kernel/db-stores'
import type { EventSink } from '$lib/kernel/events'
import { CHAT_GATEWAY_MODULE_ID, type Brain } from '$lib/kernel/gateway'
import { ModuleRegistry, type ActivationStore } from '$lib/kernel/modules'
import type { PrincipalStore } from '$lib/kernel/principals'
import { KernelRegistry, type PrincipalScope } from '$lib/kernel/registry'
import { type VcsCommitter, vcsCommitterFromEnv } from '$lib/kernel/vcs'
import { registerModuleTools, type WiredKernel } from '$lib/kernel/wiring'
import type { AppDatabase } from '$lib/server/db/context'
import { createGitHubTokenClient } from '$lib/server/github/token'
import { livePrincipalScope } from '$lib/server/kernel/principal-scope'
import { ASSISTANT_MODULE_ID, assistantManifest } from './assistant/manifest'
import { createAssistantTools } from './assistant/tools'
import { BRAND_MODULE_ID, BRAND_WRITE_TOOLS, brandManifest } from './brand/manifest'
import { createBrandTools } from './brand/tools'
import { CALENDAR_MODULE_ID, CALENDAR_WRITE_TOOLS, calendarManifest } from './calendar/manifest'
import { createCalendarTools } from './calendar/tools'
import { CALLS_MODULE_ID, CALLS_WRITE_TOOLS, callsManifest } from './calls/manifest'
import { createCallsTools } from './calls/tools'
import { DbAllowlistStore } from './chat-gateway/db-stores'
import { createChatGateway, type ChatGatewayBoot } from './chat-gateway/index'
import { telegramClientFromEnv } from './chat-gateway/telegram'
import { liveCompanyModules } from './company-modules/live'
import { COMPANY_MODULES_MODULE_ID, companyModulesManifest } from './company-modules/manifest'
import { COMPANY_MODULES_GATED_TOOLS, createCompanyModulesTools } from './company-modules/tools'
import { CONTACTS_MODULE_ID, CONTACTS_WRITE_TOOLS, contactsManifest } from './contacts/manifest'
import { createContactsTools } from './contacts/tools'
import { contributeHubManifest } from './contribute/hub/manifest'
import { createContributeHubTools } from './contribute/hub/tools'
import { CONTRIBUTE_MODULE_ID, CONTRIBUTE_WRITE_TOOLS, contributeManifest } from './contribute/manifest'
import { createContributeTools } from './contribute/tools'
import { COWORKERS_GATED_TOOLS, COWORKERS_MODULE_ID, coworkersManifest } from './coworkers/manifest'
import { createCoworkersTools } from './coworkers/tools'
import { DEMO_GUEST_ACCESS_SET_TOOL, DEMO_SEED_TOOL, demoManifest } from './demo/manifest'
import { createDemoTools } from './demo/tools'
import { DOMAINS_MODULE_ID, domainsManifest } from './domains/manifest'
import { createDomainsTools } from './domains/tools'
import { driveSourceWriter } from './drive'
import {
  DRIVE_MODULE_ID,
  DRIVE_SHEET_COPY_TOOL_NAMES,
  DRIVE_SHEET_LIVE_WRITE_TOOLS,
  DRIVE_SHEET_WRITE_TOOLS,
  ARTIFACT_WRITE_TOOLS,
  DRIVE_WRITE_TOOLS,
  driveManifest,
} from './drive/manifest'
import { resolveDriveStorageDir } from './drive/storage'
import { createDriveTools } from './drive/tools'
import { EMAIL_INBOX_WRITE_TOOLS } from './email/inbox/tool-names'
import { createInboxTools } from './email/inbox/tools'
import { EMAIL_MODULE_ID, emailManifest } from './email/manifest'
import { createOwleryTools } from './email/owlery/tools'
import { EMAIL_PLATFORM_WRITE_TOOLS } from './email/platform/tool-names'
import { createEmailPlatformTools } from './email/platform/tools'
import { createEmailTools } from './email/tools'
import { MEMBERS_MODULE_ID, membersManifest } from './members/manifest'
import { createMembersTools } from './members/tools'
import { MEMORY_MODULE_ID, memoryManifest } from './memory/manifest'
import { createMemoryTools } from './memory/tools'
import { MESSAGES_MODULE_ID, messagesManifest } from './messages/manifest'
import { createMessagesTools } from './messages/tools'
import { moduleHubManifest } from './module-hub/manifest'
import { createModuleHubTools } from './module-hub/tools'
import { createAllowlistAdminTools } from './orchestrator/allowlist-tools'
import { orchestratorManifest } from './orchestrator/manifest'
import { createRepoEngine } from './orchestrator/repo/index'
import { createRepoTools, type RepoEngine } from './orchestrator/repo/tools'
import { provideConnectedReposPort } from './orchestrator/repos-context'
import { createRoadmapTools } from './orchestrator/roadmap/tools'
import { createRecapModule, type RecapBoot } from './recap'
import { RECAP_MODULE_ID } from './recap/types'
import { provideReposPorts, reposService } from './repos/live'
import { REPOS_MODULE_ID, reposManifest } from './repos/manifest'
import { createReposTools } from './repos/tools'
import { createWebsiteFoundingTools } from './website/founding-tools'

export type { RecapBoot } from './recap'
import { createActivityTools } from './website/activity-tools'
import { createDomainTools } from './website/apps/domain-tools'
import { APP_AGENT_GATED_TOOLS, createAppTools } from './website/apps/tools'
import { createGitHubConnectTools } from './website/github/connect-tools'
import { createGitHubTools } from './website/github/tools'
import { createSubstrateTools } from './website/hosting/tools'
import { WEBSITE_MODULE_ID, websiteManifest } from './website/manifest'
import { createWebsiteTools } from './website/tools'

export { registerModuleTools, type WiredKernel } from '$lib/kernel/wiring'
export { providePublishPort, startCompanyModules } from './company-modules/live'
export type { ChatGatewayBoot } from './chat-gateway/index'

/**
 * The static module surface of this eigenEnterprise instance
 * (plan/phase-platform.md step 1): website = site + hosting + GitHub;
 * email = Owlery + transactional send; orchestrator = the agent's internal
 * repo / roadmap tools (no owner-facing card). Tool names are
 * unchanged: merged modules own several tool namespaces.
 */
export const moduleManifests = [
  memoryManifest,
  emailManifest,
  websiteManifest,
  brandManifest,
  orchestratorManifest,
  membersManifest,
  coworkersManifest,
  messagesManifest,
  driveManifest,
  contributeManifest,
  callsManifest,
  contactsManifest,
  reposManifest,
  calendarManifest,
  // The central Contribute board (plan/contribute-phone-home.md §3): registered everywhere, never
  // self-seeded — off until the owner switches it on, on os.cerberusblue.com only.
  contributeHubManifest,
  // The central module hub (plan/phase-upgrades-u2.md §7): like the Contribute board, registered
  // everywhere, never self-seeded — off until the owner switches it on, on the central box only.
  moduleHubManifest,
  assistantManifest,
  domainsManifest,
  // The demo company seed (plan/phase-demo-company.md): registered everywhere, never
  // self-seeded — off until the owner switches it on, on the demo box only.
  demoManifest,
  // The company's own modules (plan/phase-upgrades-u2.md §8): the modules.* tools.
  companyModulesManifest,
] as const

/**
 * The modules every company starts with, self-seeded active once
 * (ensureSystemModulesActive). The plugins among them (a sidebar entry) can be
 * switched off in Settings → Plugins; the internal ones are the core.
 * Brand joined in C3: the style the owner picks is the whole app's look, so the
 * picker must never sit behind an activation step (its consequential acts stay
 * gated per tool: brand.visual_set_activate / brand.set_activate need approval,
 * the picker's choose is owner-only).
 */
export const SYSTEM_MODULE_IDS = [
  WEBSITE_MODULE_ID,
  EMAIL_MODULE_ID,
  MEMBERS_MODULE_ID,
  // Memory (phase-cohesion C3): the owner's notes/tasks/projects/capture and the
  // agent's memory tools are core, never an optional extension.
  MEMORY_MODULE_ID,
  BRAND_MODULE_ID,
  // Messages (phase-workspace C1): the team's chat is part of the OS.
  MESSAGES_MODULE_ID,
  // Drive (plan/phase-workspace.md D1): the company's files are core, like Memory.
  DRIVE_MODULE_ID,
  // Contribute: everyone proposes improvements from the top bar; the agent picks them up.
  CONTRIBUTE_MODULE_ID,
  // Calls (plan/video-calls.md): video calls ring on any nucleus page; part of the OS.
  CALLS_MODULE_ID,
  // Contacts (plan/contribute-round-3.md W1): the people the company knows, part of the OS.
  CONTACTS_MODULE_ID,
  // GitHub repos (plan/github-drive.md): read-only repo copies in Drive; idle until a token is pasted.
  REPOS_MODULE_ID,
  // Calendar (plan/calendar.md): each member's appointments and colleagues' availability.
  CALENDAR_MODULE_ID,
  // Assistant (round 5): the shell's top bar and panel and the conversations — an
  // official plugin, switchable; the agent engine, registry and approvals stay core.
  ASSISTANT_MODULE_ID,
  // Domains (plan/domains-one-claim.md D2): a global setting, core like Members.
  DOMAINS_MODULE_ID,
  // AI co-workers and the org chart (plan/phase-ai-coworkers.md C1): core like Members.
  COWORKERS_MODULE_ID,
  // Modules (plan/phase-upgrades-u2.md §8): the company's own vibe-coded modules; core like Members.
  COMPANY_MODULES_MODULE_ID,
] as const

/** Tools that always require an approval decision before first execution. */
export const APPROVAL_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  // Company email (the one send tool): an agent's send waits for the owner's yes.
  'email.send_mail',
  // Email platform changes (domains, senders, suppressions) wait on the approval mode.
  ...EMAIL_PLATFORM_WRITE_TOOLS,
  // The inbox: working mail and mailboxes as the calling person (parity with Email › Inbox).
  ...EMAIL_INBOX_WRITE_TOOLS,
  // Phase-2c (G8/D5): guideline-set activation is a strategic brand decision —
  // human-admin principal AND an explicit approval decision.
  'brand.set_activate',
  // Phase-2d M5 (V9): visual-set activation is THE strategic go-live moment —
  // once approved, the set's tokens apply globally to every user-facing
  // surface (root :root override, public hero, shader tints).
  'brand.visual_set_activate',
  // Brand › Social: an agent's delete of a post and its files waits on the approval mode.
  ...BRAND_WRITE_TOOLS,
  // Website founding journey: publishing is a public, owner-owned act — the
  // journey's website.publish_page artifacts gate here (approval_required),
  // surfacing as the chatbox approval card until the owner decides.
  'website.publish_page',
  // Phase-3 M2: the agent's repo hands land on the instance repo here —
  // merging agent work into the company repo is an owner decision made in chat.
  'repo.merge',
  // Module lifecycle: ACTIVATING is the agent's own job (owner, 2026-10-20: the
  // harness fixes "module not active" itself — audited, reversible, no approval).
  // DEACTIVATING takes capability away from the company: the owner's yes in chat.
  'kernel.module_deactivate',
  // Connecting a GitHub repo is internal (auto in "reasonable" mode); disconnecting
  // drops what a deploy depends on, so it is destructive (plan/github-connect.md).
  'website.github_connect_repo',
  'website.github_disconnect_repo',
  // Deploying an app and setting its env change the server: the agent may do it
  // only through this gate (owner decision 3, plan/phase-platform.md; D11).
  ...APP_AGENT_GATED_TOOLS,
  // Members: inviting sends company mail to a person (external); a role change
  // grants or takes away rights (internal). Both wait on the approval mode.
  'members.invite',
  'members.set_role',
  // Groups decide who sees shared folders and channels: changing one is internal,
  // deleting one takes access away (destructive).
  'members.group_create',
  'members.group_update',
  'members.group_delete',
  // Removing a member takes their access away (destructive); a person's own profile
  // (what they are called, their names and picture) is internal.
  'members.remove',
  // Open join lets anyone with a verified email in as a member (public).
  'members.set_open_join',
  // AI co-workers: changing one, switching it on or off, and a seat in the org chart (internal).
  // Creating and removing one always ask (approvalAlways), whatever the mode.
  ...COWORKERS_GATED_TOOLS,
  'members.set_my_called',
  'members.set_my_name',
  'members.set_my_picture',
  // Assistant: naming one's own conversation (internal).
  'assistant.conversation_rename',
  // Drive: an agent's write replaces a company file's text (kept as a revision).
  'drive.write_text',
  // Drive: an agent's new document (internal documents go here, never the website).
  'drive.create_document',
  // Drive archive: hides items from everyone's normal view (reversible, nothing deleted).
  'drive.archive',
  'drive.unarchive',
  // Drive file management (create, upload, rename, move, share, trash, delete forever, revisions).
  ...DRIVE_WRITE_TOOLS,
  // Drive spreadsheets: an agent's cell writes and sheet/row/column changes (a new revision).
  ...DRIVE_SHEET_WRITE_TOOLS,
  // Drive: an editable .xlsx copy of an .xls/.ods (a new file next to the original).
  ...DRIVE_SHEET_COPY_TOOL_NAMES,
  // Drive spreadsheets co-edited: a batch of changes into an open workbook's log.
  ...DRIVE_SHEET_LIVE_WRITE_TOOLS,
  // Drive artifacts: an agent's new or changed page/deck, and its PDF export (a new file).
  ...ARTIFACT_WRITE_TOOLS,
  // Calls: ringing, booking meetings / inviting guests (external mail), removing a guest and
  // the Company Brain's switch and shares wait on the approval mode.
  ...CALLS_WRITE_TOOLS,
  // Calendar: changes to the person's calendar (and accepting a mailed appointment, which
  // sends an invitation) wait on the approval mode.
  ...CALENDAR_WRITE_TOOLS,
  // Contacts: an agent's adds, edits and logged contacts wait on the approval mode (internal).
  ...CONTACTS_WRITE_TOOLS,
  // Contribute: a proposal or vote made through the agent waits on the approval mode (internal).
  ...CONTRIBUTE_WRITE_TOOLS,
  // Central board: revoking an install refuses it from now on (destructive for that install).
  'contribute_hub.revoke_install',
  // Company modules (plan/phase-upgrades-u2.md §8, D13): a deploy that widens nothing follows the mode.
  ...COMPANY_MODULES_GATED_TOOLS,
  // The demo seed publishes website pages and makes member accounts (public);
  // login-free guest access lets anyone on the internet enter the shared demo seat (public).
  DEMO_SEED_TOOL,
  DEMO_GUEST_ACCESS_SET_TOOL,
])

export type BootstrapKernelOptions = {
  /** Overrides the lazy per-request `getDb()` handle (tests inject fakes). */
  db?: DbHandle
  activations?: ActivationStore
  eventSink?: EventSink
  approvalStore?: ApprovalStore
  /** Overrides the DB-backed company approval mode (tests inject in-memory). */
  approvalMode?: ApprovalModeStore
  principals?: PrincipalStore
  /** Defaults to vcsCommitterFromEnv: off unless EE_VCS_REPO_DIR names the repository. */
  vcsCommitter?: VcsCommitter | null
  /** Overrides the repo engine (tests inject one with fake runners). */
  repoEngine?: RepoEngine
  /**
   * Row-level-security scope of every person's tool call (CB3). bootstrapKernel
   * wires the live one (src/lib/server/kernel/principal-scope.ts); a bare
   * buildKernel (in-memory specs) runs handlers as called.
   */
  principalScope?: PrincipalScope
}

/**
 * Build a fully wired kernel. Defaults are DB-backed (kernel_* tables) with a
 * lazy db provider so nothing connects until an operation actually runs;
 * inject fakes for in-memory use.
 */
const GITHUB_TIMEOUT_MS = 20_000
/**
 * A tarball download (plan/github-drive-full-mirror.md §3) runs inside one
 * repo's sync claim (CLAIM_LEASE_MS, 10 min), so it must end well before the
 * claim lapses and another process could take the same repo.
 */
const GITHUB_TARBALL_TIMEOUT_MS = 8 * 60_000
/** The download cap: the plan's 2 GB per repo (§2.4). */
const GITHUB_TARBALL_MAX_BYTES = 2 * 1024 ** 3
/** Where tarballs are streamed: under Drive's storage dir (fails loud without one, never a default). */
const githubTarballDir = () => join(resolveDriveStorageDir(process.env), 'github-tarballs')

/**
 * Drive's source writer as the repos plugin's DriveSourcePort (modules never
 * import each other; the composition root adapts). The live writer is built
 * lazily on first use, so building the kernel touches no database.
 */
function reposDrivePort(): DriveSourcePort {
  return {
    ensureRoot: async (...a) => (await driveSourceWriter()).ensureRoot(...a),
    upsertFolder: async (...a) => (await driveSourceWriter()).upsertFolder(...a),
    upsertText: async (...a) => (await driveSourceWriter()).upsertText(...a),
    upsertBytes: async (...a) => (await driveSourceWriter()).upsertBytes(...a),
    upsertMany: async (...a) => (await driveSourceWriter()).upsertMany(...a),
    remove: async (...a) => (await driveSourceWriter()).remove(...a),
    list: async (...a) => (await driveSourceWriter()).list(...a),
  }
}

/**
 * The email platform's mail domains as the domains module reads them (modules
 * never import each other; the composition root adapts). Lazy: building the
 * kernel touches no database.
 */
async function liveMailDomains(): Promise<MailDomain[]> {
  const { emailPlatform } = await import('./email/platform/service')
  return (await emailPlatform().listDomains()).map((d) => ({
    name: d.name,
    sendable: d.sendable,
    receiving: d.receiving,
    records: d.records,
  }))
}

/** Domains bought through eigenEnterprise; a box without the domains service (EE_DOMAINS_* unset) has none. */
async function liveBoughtDomains(): Promise<BoughtDomain[]> {
  const [{ domainsFromEnv }, { domainsClient }] = await Promise.all([
    import('$lib/server/domains/env'),
    import('$lib/server/domains/client'),
  ])
  const config = domainsFromEnv()
  return config ? domainsClient(config).list() : []
}

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
      const { companyDb } = await import('$lib/server/db')
      return companyDb()
    })

  // Cached in-process (the plugin gate reads it per request); every switch is
  // announced so the other processes (the ee CLI, a second app slot) drop theirs.
  const activations =
    options.activations ??
    new CachedActivationStore(new DbActivationStore(db), {
      announce: (id) => notifyActivationChange(db, id),
    })
  const eventSink = options.eventSink ?? new DbEventSink(db)
  const approvalStore = options.approvalStore ?? new DbApprovalStore(db)
  const approvalMode = options.approvalMode ?? new DbApprovalModeStore(db)
  const principals = options.principals ?? new DbPrincipalStore(db)
  const vcsCommitter =
    options.vcsCommitter === undefined ? vcsCommitterFromEnv(process.env) : options.vcsCommitter

  const modules = new ModuleRegistry(activations)
  for (const manifest of moduleManifests) modules.register(manifest)

  const registry = new KernelRegistry({
    eventSink,
    activationStore: activations,
    approvalPolicy: new ModeAwareApprovalPolicy(APPROVAL_REQUIRED_TOOLS, approvalMode),
    approvalStore,
    vcsCommitter,
    ...(options.principalScope ? { principalScope: options.principalScope } : {}),
  })

  provideReposPorts({
    drive: reposDrivePort(),
    client: (token) =>
      createGitHubTokenClient({
        token,
        fetch,
        timeoutMs: GITHUB_TIMEOUT_MS,
        tarballDir: githubTarballDir(),
        tarballTimeoutMs: GITHUB_TARBALL_TIMEOUT_MS,
        tarballMaxBytes: GITHUB_TARBALL_MAX_BYTES,
        // Test seam (the e2e mock GitHub); same precedent as llm/oauth/github-copilot.ts.
        apiBase: process.env.GITHUB_TOKEN_API_BASE_URL?.trim() || 'https://api.github.com',
        codeloadOrigin:
          process.env.GITHUB_CODELOAD_BASE_URL?.trim() || 'https://codeload.github.com',
      }),
    tarballDir: githubTarballDir,
    tarballMaxBytes: GITHUB_TARBALL_MAX_BYTES,
  })

  // The orchestrator's "Connected GitHub repos" block: only while the plugin is
  // on (a plugin switched off is really off), only repos that have synced.
  provideConnectedReposPort(async () => {
    if ((await activations.get(REPOS_MODULE_ID)) !== true) return []
    return (await reposService().briefs()).map((b) => ({
      fullName: b.fullName,
      lastPushAt: b.lastPushAt,
      openPulls: b.openPulls,
      summary: b.summaryFirstSentence,
      summaryStale: b.summaryStale,
      driveFolderId: b.driveFolderId,
    }))
  })

  registerModuleTools(registry, modules, [
    ...createMemoryTools(),
    ...createEmailTools(),
    ...createWebsiteTools(),
    ...createWebsiteFoundingTools(),
    ...createBrandTools(),
    ...createRepoTools({
      engine: options.repoEngine ?? createRepoEngine({ eventSink }),
    }),
    ...createRoadmapTools(),
    ...createSubstrateTools(),
    ...createGitHubTools(),
    ...createGitHubConnectTools(),
    ...createAppTools(),
    ...createDomainTools(),
    ...createActivityTools(),
    ...createOwleryTools(),
    ...createEmailPlatformTools(),
    ...createInboxTools(),
    ...createMembersTools(),
    ...createCoworkersTools(),
    ...createAssistantTools(),
    ...createMessagesTools(),
    ...createDriveTools(),
    ...createContributeTools(),
    ...createContributeHubTools(),
    ...createModuleHubTools(),
    ...createCallsTools({ service: liveCallsService }),
    ...createContactsTools(),
    ...createReposTools(),
    ...createCalendarTools(),
    ...createDomainsTools({ mail: liveMailDomains, bought: liveBoughtDomains }),
    // The seed drives this very registry, as the owner and each teammate.
    ...createDemoTools({ registry: () => registry, eventSink }),
    // The company's own modules (plan/phase-upgrades-u2.md §8): lazy, so composing touches nothing.
    ...createCompanyModulesTools(liveCompanyModules({ registry, modules, activations, eventSink, db }).service),
  ])

  return {
    registry,
    modules,
    activations,
    principals,
    approvals: approvalStore,
    approvalMode,
    eventSink,
  }
}

/**
 * The modules a company starts with, self-seeded active. Owner, 2026-11-12:
 * everything with a sidebar entry is a plugin and can be switched off — so a
 * plugin is switched on once (it has no activation record yet) and a plugin
 * the owner switched off stays off. The core (internal: members, contribute)
 * cannot be switched off and is always switched back on. Idempotent; call
 * before using their tools.
 */
export async function ensureSystemModulesActive(kernel: WiredKernel): Promise<void> {
  // website owns hosting (substrate) and the GitHub source provider; github does
  // nothing until connected. email owns Owlery (SES); it does nothing until the
  // owner sets it up. Hosting mutations stay human-only (D11, requireHuman). memory owns
  // the notes/tasks/projects store and the agent's memory tools.
  const recorded = await kernel.activations.list()
  for (const id of SYSTEM_MODULE_IDS) {
    const core = kernel.modules.get(id)?.internal === true
    const seed = core ? recorded.get(id) !== true : !recorded.has(id)
    if (seed) await kernel.activations.set(id, true)
  }
}

let singleton: WiredKernel | null = null

/** Process-wide kernel (first call wins; later options are ignored). */
export function bootstrapKernel(options: BootstrapKernelOptions = {}): WiredKernel {
  if (!singleton) singleton = buildKernel({ principalScope: livePrincipalScope, ...options })
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
    // A link names a member: the brain resolves who that is.
    ...createAllowlistAdminTools(gatewayBoot.allowlist, { personFor: (id) => brain.personFor(id) }),
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

// ─── Calls ↔ Messages (plan/video-calls.md §2) ───────────────────────────────
// Who may be in a DM/channel call is Messages' answer. Modules never import
// each other, so the adapter lives here in the composition root: Calls codes
// against its CallContextPort, Messages stays call-agnostic.

/** CallContextPort over Messages' own access rules (a DM's people; a channel's readers). */
export function callContextsFromMessages(load: () => Promise<MessagesDeps>): CallContextPort {
  const conversation = async (kind: 'dm' | 'channel', id: string) => {
    const svc = await import('./messages/service')
    if (!svc.isId(id)) return null
    const d = await load()
    const c = await d.store.getConversation(id)
    return c && c.kind === kind ? { d, svc, c } : null
  }
  return {
    async open(actorId, kind, id) {
      const found = await conversation(kind, id)
      // Starting a call is like posting: archived channels and read-only members cannot.
      if (!found || !(await found.svc.canUse(found.d, actorId, found.c, 'edit'))) return null
      const members = await found.svc.conversationMembers(found.d, actorId, found.c.id)
      const title =
        found.c.kind === 'channel'
          ? `#${found.c.name}`
          : members.map((p) => p.name.trim() || p.email).join(', ')
      return { title, memberIds: members.map((p) => p.id) }
    },
    async isMember(userId, kind, id) {
      const found = await conversation(kind, id)
      return !!found && (await found.svc.canUse(found.d, userId, found.c, 'view'))
    },
  }
}

/**
 * CallLogPort into Messages: a DM/channel call that is over becomes one call
 * line in that conversation ("Call, 4 min" / "Missed call"), structured data
 * on the message, once per call (a repeat is a no-op on the Messages side).
 */
export function callLogToMessages(load: () => Promise<MessagesDeps>): CallLogPort {
  return {
    async callEnded(ended) {
      const svc = await import('./messages/service')
      await svc.postCallLine(await load(), {
        conversationId: ended.contextId,
        authorId: ended.startedBy,
        call: {
          callId: ended.callId,
          outcome: ended.outcome,
          durationSeconds: ended.durationSeconds,
        },
      })
    },
  }
}

const liveMessagesDeps = async (): Promise<MessagesDeps> =>
  (await import('./messages/live')).messagesDeps()

const liveCallsPorts = () => ({
  contexts: callContextsFromMessages(liveMessagesDeps),
  log: callLogToMessages(liveMessagesDeps),
})

/** This process's Calls service, its conversations answered by the live Messages. */
export async function liveCallsService(): Promise<CallsService> {
  const { callsService } = await import('./calls/live')
  return callsService(liveCallsPorts())
}

/** This process's Calls hub (LISTEN ee_calls). */
export async function liveCallsHub(): Promise<CallsHub> {
  const { callsHub } = await import('./calls/live')
  return callsHub(liveCallsPorts())
}
