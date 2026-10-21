import { z } from 'zod'
import type { KernelEvent } from '$lib/kernel/events'
import type { ToolDescriptor } from '$lib/kernel/types'
import { listKernelEvents } from '$lib/server/activity/kernel-events'
import {
  EeClient,
  SubstrateError,
  SubstrateUnavailableError,
  type EeStatus,
} from '$lib/server/ee/client'
import { AppUserError } from './apps/contract'
import { WEBSITE_ACTIVITY_TOOL, WEBSITE_MODULE_ID } from './manifest'

/**
 * website.activity (plan/phase-website-apps-ux.md W5): the Website module
 * page's recent activity in one read — ee's server journal (deploys, secrets,
 * keys, workload life cycle) plus the kernel's tool audit rows for this
 * module's namespaces. Kinds and sentences come from structural identifiers
 * only — the ee event type, the kernel tool id, and the audit's stored
 * `activity` sentence — never from parsing message text (server events'
 * `message` is deliberately not shown).
 */

/** ee's read the activity tool needs; a seam so tests fake ee without a socket. */
export type ActivityEe = Pick<EeClient, 'status'>

/** The kernel audit read (listKernelEvents); a seam so tests fake the trail. */
export type ToolEventSource = (limit: number) => Promise<KernelEvent[]>

export type ActivityToolDeps = { ee?: ActivityEe; toolEvents?: ToolEventSource }

const KINDS = ['deploy', 'domain', 'secret', 'key', 'app', 'page', 'server'] as const
export type ActivityKind = (typeof KINDS)[number]

export type ActivityItem = {
  at: string
  source: 'server' | 'tool'
  kind: ActivityKind
  text: string
  workload: string | null
  href: string | null
}

export type ActivityResult = { managed: boolean; items: ActivityItem[] }

const activityInput = z.object({ limit: z.number().int().positive().max(50).optional() }).strict()
const activityOutput = z.object({
  managed: z.boolean(),
  items: z.array(
    z.object({
      at: z.string(),
      source: z.enum(['server', 'tool']),
      kind: z.enum(KINDS),
      text: z.string(),
      workload: z.string().nullable(),
      href: z.string().nullable(),
    }),
  ),
})

const DEFAULT_LIMIT = 20
/** How many kernel audit rows the scan reads before the namespace filter. */
const TOOL_EVENT_SCAN = 200

/** ee failures in plain words; the original stays in the server log and as `cause`. */
async function viaEe<T>(what: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (err) {
    if (err instanceof AppUserError) throw err
    if (err instanceof SubstrateUnavailableError)
      throw new AppUserError(
        "Reading the server's activity needs the deploy agent (ee). This copy of Eigen Enterprise isn't running on a server set up with ee.",
        { cause: err },
      )
    if (err instanceof SubstrateError) {
      console.error(`[website/activity] ee could not ${what}: ${err.status} ${err.message}`)
      throw new AppUserError(
        `The server's deploy agent could not ${what}. Try again; if it keeps happening, ask in the chat.`,
        { cause: err },
      )
    }
    throw err
  }
}

// ── server events: ee's journal, mapped by type ─────────────────────────────

/** Everything ee runs except the OS itself has an app page. */
function appHref(workload: string | null): string | null {
  return workload && workload !== 'os' ? `/m/website/apps/${workload}` : null
}

function serverItem(type: string, workload: string | null, at: string): ActivityItem {
  const href = appHref(workload)
  const base = { at, source: 'server' as const, workload, href }
  if (type === 'deploy.started')
    return {
      ...base,
      kind: 'deploy',
      text: workload ? `Started deploying ${workload}` : 'Started a deploy',
    }
  if (type === 'deploy.succeeded')
    return {
      ...base,
      kind: 'deploy',
      text: workload ? `Deployed ${workload}` : 'Deployed a workload',
    }
  if (type === 'deploy.failed')
    return {
      ...base,
      kind: 'deploy',
      text: workload ? `Deploy of ${workload} failed` : 'A deploy failed',
    }
  if (type === 'secret.set')
    return {
      ...base,
      kind: 'secret',
      text: workload ? `Set a secret for ${workload}` : 'Set a secret',
    }
  if (type === 'deploy_key.created') return { ...base, kind: 'key', text: 'Added a deploy key' }
  if (type === 'deploy_key.deleted') return { ...base, kind: 'key', text: 'Removed a deploy key' }
  if (type === 'workload.error')
    return {
      ...base,
      kind: 'server',
      text: workload ? `${workload} hit an error` : 'A workload hit an error',
    }
  if (type === 'workload.repaired')
    return {
      ...base,
      kind: 'server',
      text: workload ? `Repaired ${workload}` : 'Repaired a workload',
    }
  if (type === 'workload.removed')
    return {
      ...base,
      kind: 'server',
      text: workload ? `Removed ${workload}` : 'Removed a workload',
    }
  if (type === 'edge.updated')
    return { ...base, kind: 'server', text: 'Updated the server’s edge routing' }
  if (type === 'state.committed')
    return { ...base, kind: 'server', text: 'Applied a change to the server' }
  if (type === 'claim.issued') return { ...base, kind: 'server', text: 'Set up this server (ee)' }
  // Unknown ee types show the type verbatim — honest, never a guess.
  return { ...base, kind: 'server', text: type }
}

// ── tool events: the kernel audit, filtered to this module's namespaces ─────

/** The website module's tool namespaces (websiteManifest.toolNamespaces). */
const NAMESPACES = ['website.', 'substrate.', 'github.']

const auditPayload = z.object({
  tool: z.string(),
  ok: z.boolean(),
  auditClass: z.string().optional(),
  activity: z.string().optional(),
})

/**
 * Tool id → kind, by structural match on the id itself (exact id first, then
 * id families) — never message text. Anything unmatched is kind `server`.
 */
export function toolEventKind(tool: string): ActivityKind {
  if (tool === 'website.app_deploy') return 'deploy'
  if (tool.startsWith('website.app_domain_')) return 'domain'
  if (tool.startsWith('substrate.domain_')) return 'domain'
  if (tool.includes('secret')) return 'secret'
  if (tool.includes('deploy_key')) return 'key'
  if (tool === 'website.app_remove' || tool.startsWith('github.app_')) return 'app'
  if (
    tool === 'website.create_page' ||
    tool === 'website.update_page' ||
    tool === 'website.publish_page'
  )
    return 'page'
  return 'server'
}

export function toolEventItem(
  event: KernelEvent,
  payload: { tool: string; activity?: string },
): ActivityItem {
  return {
    at: event.ts,
    source: 'tool',
    kind: toolEventKind(payload.tool),
    text: payload.activity ?? `${event.principalId ?? 'someone'} ran ${payload.tool}`,
    workload: null,
    href: null,
  }
}

/**
 * The audit keeps failed and read calls too; neither is work to show. A failed
 * call's stored sentence would read as if the change happened, and the item
 * schema has no failure marker — failures surface loudly on the app page and
 * in the chat instead. Reads (including this tool's own) are noise: every
 * console page load would otherwise crowd the list.
 */
function isWorkToShow(payload: { ok: boolean; auditClass?: string; tool: string }): boolean {
  if (!payload.ok) return false
  if (payload.auditClass === 'read') return false
  return NAMESPACES.some((ns) => payload.tool.startsWith(ns))
}

export function createActivityTools(deps: ActivityToolDeps = {}): ToolDescriptor[] {
  const ee: ActivityEe = deps.ee ?? new EeClient()
  const toolEvents: ToolEventSource =
    deps.toolEvents ??
    (async (limit) => {
      const { getDb } = await import('$lib/server/db')
      return listKernelEvents(getDb(), { types: ['tool.executed'], limit })
    })

  async function toolItems(): Promise<ActivityItem[]> {
    const rows = await toolEvents(TOOL_EVENT_SCAN)
    const items: ActivityItem[] = []
    for (const row of rows) {
      const payload = auditPayload.safeParse(row.payload)
      if (!payload.success) throw new Error(`malformed tool.executed audit payload at ${row.ts}`)
      if (!isWorkToShow(payload.data)) continue
      items.push(toolEventItem(row, payload.data))
    }
    return items
  }

  return [
    {
      name: WEBSITE_ACTIVITY_TOOL,
      module: WEBSITE_MODULE_ID,
      summary:
        "The Website module's recent activity, newest first: deploys, domains, secrets, deploy keys, apps and pages — from the server's (ee) journal and this module's own tool audit.",
      auditClass: 'read',
      inputSchema: activityInput,
      outputSchema: activityOutput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const limit = activityInput.parse(input).limit ?? DEFAULT_LIMIT
        const tools = await toolItems()
        let status: EeStatus | null = null
        try {
          status = await ee.status()
        } catch (err) {
          // Only "ee is not there" becomes the explicit managed:false state
          // (the panel says so); any other ee problem stays loud, in plain words.
          if (!(err instanceof SubstrateUnavailableError))
            await viaEe('read the server status', () => Promise.reject(err))
        }
        const serverItems = status
          ? status.events.map((e) => serverItem(e.type, e.workload, e.time))
          : []
        const items = [...serverItems, ...tools]
          .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
          .slice(0, limit)
        return { managed: status !== null, items } satisfies ActivityResult
      },
    },
  ]
}
