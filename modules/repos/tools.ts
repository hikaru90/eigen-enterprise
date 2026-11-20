import type { ReposService, SourceView } from './service'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { REPOS_MODULE_ID, REPOS_TOOL_NAMES } from './manifest'

/**
 * repos.* kernel tools (plan/github-drive.md §6, plan/github-drive-full-mirror.md
 * §6): list the connected repos with their status and Drive folder ids, sync
 * one now, and choose which files a repo copies (all of them, or the Markdown
 * docs only). None of them touches the token — that only ever goes through the
 * admin's own form on /drive/github.
 */

export type ReposToolDeps = { service?: () => Promise<ReposService> }

const listInput = z.object({}).strict()
const syncInput = z.object({ repo: z.string().min(1).describe('owner/name, or the numeric GitHub repo id') }).strict()
const copyModeInput = z
  .object({
    repoId: z.number().int().positive().describe('the numeric GitHub repo id (repos.list shows it)'),
    mode: z.enum(['all', 'docs']).describe("'all' copies every file of the default branch; 'docs' only the Markdown files"),
  })
  .strict()

const iso = (d: Date | null) => (d ? d.toISOString() : null)
const view = (s: SourceView) => ({
  repo: s.fullName,
  repoId: s.repoId,
  defaultBranch: s.defaultBranch,
  copyMode: s.copyMode,
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
  const [listName, syncName, copyModeName] = REPOS_TOOL_NAMES
  return [
    {
      name: listName,
      module: REPOS_MODULE_ID,
      summary:
        'List the GitHub repos synced into Drive (read-only copies under GitHub / <owner> / <repo>): last sync, next sync, any error, the Drive folder id and whether the repo copies all files or only the Markdown docs. Read Overview.md, Branches.md, Pull requests.md and Activity.md there with drive.list / drive.read.',
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
    {
      name: copyModeName,
      module: REPOS_MODULE_ID,
      summary:
        "Choose which files a connected GitHub repo copies into Drive: 'all' (every file of the default branch, the default) or 'docs' (only the Markdown files, for huge monorepos). The next sync applies it: switching to 'docs' removes the non-doc files.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof copyModeInput>, output: unknown) => {
        const name = (output as { repo?: string } | undefined)?.repo ?? `repo ${input.repoId}`
        const what = input.mode === 'docs' ? 'the Markdown docs only' : 'all files'
        return `Set ${name} to copy ${what}`
      },
      inputSchema: copyModeInput,
      permission: { roles: ['owner', 'admin'] },
      handler: async (_ctx, input) => {
        const { repoId, mode } = copyModeInput.parse(input)
        const out = await (await service()).setCopyMode(repoId, mode)
        return { repo: out.fullName, repoId, copyMode: out.copyMode }
      },
    },
  ]
}
