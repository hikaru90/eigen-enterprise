import { z } from 'zod'
import type { ModuleManifest } from '$lib/kernel/modules'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { approvalActionLabel } from '$lib/chat/approval-copy'

/**
 * The owner's overview: which module is active, and where the work can be seen.
 * Read-only by construction — every source is a read tool or a store read.
 * Detail stays in the chat; this is the calm index of results.
 */

export type OverviewResult = { label: string; detail: string | null; href: string | null }
export type OverviewCount = { label: string; value: number }

export type ModuleOverview = {
  id: string
  name: string
  description: string
  active: boolean
  results: OverviewResult[]
  /** Key numbers for the dashboard card (structured; never parsed from labels). */
  counts: OverviewCount[]
  /** A plain sentence when results can't be shown (never server error text). */
  note: string | null
}

export type OverviewAction = { at: string; text: string; ok: boolean }
export type OverviewApproval = { id: string; text: string }

export type Overview = {
  modules: ModuleOverview[]
  actions: OverviewAction[]
  approvals: OverviewApproval[]
}

/** The read side of the kernel registry the overview needs. */
export type OverviewRegistry = {
  get(name: string): ToolDescriptor | undefined
  execute(name: string, input: unknown, ctx: ToolContext): Promise<unknown>
}

export type ResultSourceDeps = { registry: OverviewRegistry; ctx: ToolContext }
export type ResultSource = (
  deps: ResultSourceDeps,
) => Promise<Pick<ModuleOverview, 'results' | 'note'> & { counts?: OverviewCount[] }>

export type AuditEventRow = { ts: string; payload: unknown }
export type PendingApprovalRow = { id: string; toolName: string }

export type OverviewDeps = {
  manifests: ModuleManifest[]
  activations: Map<string, boolean>
  registry: OverviewRegistry
  ctx: ToolContext
  /** Owner/admin: only they read module results through the kernel. */
  canReadResults: boolean
  resultSources: Record<string, ResultSource>
  recentToolEvents: () => Promise<AuditEventRow[]>
  pendingApprovals: () => Promise<PendingApprovalRow[]>
}

// ─── website (contract: website.site_info, owned by the website workstream) ──

export const SITE_INFO_TOOL = 'website.site_info'

const siteInfoOutput = z.object({
  url: z.string(),
  pages: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      status: z.enum(['draft', 'published']),
      url: z.string(),
    }),
  ),
})

export type JourneyStatus = 'not_started' | 'in_progress' | 'done'

const journeyLabel: Record<JourneyStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
}

export function websiteResultSource(journeyStatus: () => Promise<JourneyStatus>): ResultSource {
  return async ({ registry, ctx }) => {
    const journey: OverviewResult = {
      label: 'Founding journey',
      detail: journeyLabel[await journeyStatus()],
      href: null,
    }
    if (!registry.get(SITE_INFO_TOOL)) {
      return { results: [journey], note: 'Preview link not available yet' }
    }
    const info = siteInfoOutput.parse(await registry.execute(SITE_INFO_TOOL, {}, ctx))
    const pages = info.pages.map((page) => ({
      label: page.title,
      detail: page.status === 'published' ? 'Published' : 'Draft',
      href: page.url,
    }))
    const published = info.pages.filter((page) => page.status === 'published').length
    return {
      results: [journey, { label: 'Site', detail: null, href: info.url }, ...pages],
      counts: [
        { label: 'Published', value: published },
        { label: 'Drafts', value: info.pages.length - published },
      ],
      note: pages.length === 0 ? 'No pages yet' : null,
    }
  }
}

// ─── email (owlery.status) — only the sender address ever leaves here ───────

const owleryStatusOutput = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({ configured: z.literal(true), sender: z.string(), senderVerified: z.boolean() }),
])

export const owleryResultSource: ResultSource = async ({ registry, ctx }) => {
  const status = owleryStatusOutput.parse(await registry.execute('owlery.status', {}, ctx))
  if (!status.configured)
    return { results: [{ label: 'Not set up', detail: null, href: null }], note: null }
  return {
    results: [
      {
        label: status.sender,
        detail: status.senderVerified ? 'Set up' : 'Set up · sender not verified yet',
        href: null,
      },
    ],
    note: null,
  }
}

// ─── assembly ────────────────────────────────────────────────────────────────

const auditPayload = z.object({
  tool: z.string(),
  ok: z.boolean(),
  activity: z.string().optional(),
})

/**
 * LEGACY PATH ONLY: tool.executed events recorded before tools declared an
 * `activity` (or whose activity broke its contract) have no plain sentence.
 * They are shown honestly as "<Module name>: <tool name>" — never the
 * developer summary, never a guess.
 */
function legacyToolText(deps: OverviewDeps, tool: string): string {
  const moduleId = deps.registry.get(tool)?.module
  const manifest = deps.manifests.find((m) => m.id === moduleId)
  return manifest ? `${manifest.name}: ${tool}` : tool
}

export type ModuleOverviewDeps = Pick<
  OverviewDeps,
  'registry' | 'ctx' | 'canReadResults' | 'resultSources'
>

/** One module's entry: identity, activation, and its results when readable. */
export async function moduleOverview(
  manifest: ModuleManifest,
  active: boolean,
  deps: ModuleOverviewDeps,
): Promise<ModuleOverview> {
  const base = {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description ?? '',
    active,
  }
  const source = deps.resultSources[manifest.id]
  if (!active || !source) return { ...base, results: [], counts: [], note: null }
  if (!deps.canReadResults) {
    return { ...base, results: [], counts: [], note: 'Only the owner can see these results.' }
  }
  const { results, note, counts } = await source({ registry: deps.registry, ctx: deps.ctx })
  // A source without numbers simply has none to show.
  return { ...base, results, note, counts: counts ?? [] }
}

export async function buildOverview(deps: OverviewDeps): Promise<Overview> {
  const modules: ModuleOverview[] = []
  for (const manifest of deps.manifests) {
    // Internal modules are the agent's own machinery: no owner-facing card.
    if (manifest.internal === true) continue
    modules.push(await moduleOverview(manifest, deps.activations.get(manifest.id) === true, deps))
  }

  const actions: OverviewAction[] = []
  for (const row of await deps.recentToolEvents()) {
    const payload = auditPayload.safeParse(row.payload)
    if (!payload.success) throw new Error(`malformed tool.executed audit payload at ${row.ts}`)
    const text = payload.data.activity ?? legacyToolText(deps, payload.data.tool)
    actions.push({ at: row.ts, text, ok: payload.data.ok })
  }

  const approvals = (await deps.pendingApprovals()).map((req) => ({
    id: req.id,
    text: approvalActionLabel(req.toolName),
  }))

  return { modules, actions, approvals }
}
