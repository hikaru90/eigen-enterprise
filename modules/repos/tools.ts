import type { ReposService, SourceView } from './service'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { REPOS_MODULE_ID, REPOS_TOOL_NAMES } from './manifest'

/**
 * repos.* kernel tools (plan/github-drive.md §6): list the connected repos
 * with their status and Drive folder ids, and sync one now. Neither touches
 * the token — that only ever goes through the admin's own form on /drive/github.
 */

export type ReposToolDeps = { service?: () => Promise<ReposService> }

const listInput = z.object({}).strict()
const syncInput = z.object({ repo: z.string().min(1).describe('owner/name, or the numeric GitHub repo id') }).strict()

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const view = (s: SourceView) => ({
  repo: s.fullName,
  repoId: s.repoId,
  defaultBranch: s.defaultBranch,
  lastSyncedAt: iso(s.lastSyncedAt),
  nextDueAt: iso(s.nextDueAt),
  lastError: s.lastError,
  pausedUntil: iso(s.pausedUntil),
  driveFolderId: s.driveFolderId,
})

async function liveService(): Promise<ReposService> {
  const { reposService } = await import('./live')
  return reposService()
}

export function createReposTools(opts: ReposToolDeps = {}): ToolDescriptor[] {
  const service = opts.service ?? liveService
  const [listName, syncName] = REPOS_TOOL_NAMES
  return [
    {
      name: listName,
      module: REPOS_MODULE_ID,
      summary:
        'List the GitHub repos synced into Drive (read-only copies under GitHub / <owner> / <repo>): last sync, next sync, any error, and the Drive folder id. Read Overview.md, Branches.md, Pull requests.md and Activity.md there with drive.list / drive.read.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        listInput.parse(input)
        return { repos: (await (await service()).list()).map(view) }
      },
    },
    {
      name: syncName,
      module: REPOS_MODULE_ID,
      summary: 'Sync one connected GitHub repo into Drive now instead of waiting for the next sync (every 15 minutes).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof syncInput>, output: unknown) => {
        const name = (output as { repo?: string } | undefined)?.repo ?? input.repo
        return `Synced ${name} from GitHub`
      },
      inputSchema: syncInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (_ctx, input) => {
        const out = await (await service()).syncNow({ repo: syncInput.parse(input).repo })
        return { repo: out.fullName, ...out.outcome }
      },
    },
  ]
}
