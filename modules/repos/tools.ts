import type { ReposService, SourceView } from './service'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { REPOS_MODULE_ID, REPOS_TOOL_NAMES } from './manifest'

/**
 * repos.* kernel tools (plan/github-drive.md §6, plan/github-drive-full-mirror.md
 * §6): list the connected repos with their status and Drive folder ids, sync
 * one now, choose which files a repo copies (all of them, or the Markdown
 * docs only), see which repos each connected token can see, and start or stop
 * syncing one (Drive › GitHub's tick boxes). None of them touches the token — that only ever goes through the
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

const availableInput = z.object({}).strict()
const setRepoInput = z
  .object({
    tokenId: z.string().min(1).describe('the connected token whose access syncs it (repos.available lists them)'),
    repoId: z.number().int().positive().describe('the numeric GitHub repo id (repos.available shows it)'),
    syncing: z.boolean().describe('true = sync it into Drive; false = stop syncing it (its Drive copy is removed)'),
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
  const [listName, syncName, copyModeName, availableName, setRepoName] = REPOS_TOOL_NAMES
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
    {
      name: availableName,
      module: REPOS_MODULE_ID,
      summary:
        'The connected GitHub tokens (account login, last four characters, expiry, any error — never the token) and, for each usable one, every repo it can see with whether it syncs into Drive. Start or stop syncing one with repos.set_repo.',
      auditClass: 'read',
      inputSchema: availableInput,
      permission: { roles: ['owner', 'admin'] },
      handler: async (_ctx, input) => {
        availableInput.parse(input)
        const svc = await service()
        const tokens = await svc.tokens()
        return {
          tokens: await Promise.all(
            tokens.map(async (t) => ({
              id: t.id,
              login: t.login,
              last4: t.last4,
              expiresAt: iso(t.expiresAt),
              expired: t.expired,
              lastError: t.lastError,
              repos:
                t.lastError || t.expired
                  ? []
                  : (await svc.visibleRepos(t.id)).map((r) => ({
                      repo: r.fullName,
                      repoId: r.id,
                      private: r.private,
                      archived: r.archived,
                      syncing: r.syncing,
                    })),
            })),
          ),
        }
      },
    },
    {
      name: setRepoName,
      module: REPOS_MODULE_ID,
      summary:
        "Choose a GitHub repo to sync into Drive (syncing true; it checks the token can read it), or stop syncing it (false: its read-only copy in Drive is removed). The same as ticking the repo on Drive › GitHub.",
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof setRepoInput>, output: unknown) => {
        const name = (output as { repo?: string } | undefined)?.repo ?? `repo ${input.repoId}`
        return input.syncing ? `Started syncing ${name} into Drive` : `Stopped syncing ${name} into Drive`
      },
      inputSchema: setRepoInput,
      permission: { roles: ['owner', 'admin'] },
      handler: async (_ctx, input) => {
        const { tokenId, repoId, syncing } = setRepoInput.parse(input)
        const out = await (await service()).setRepo(tokenId, repoId, syncing)
        return { repo: out.fullName, syncing }
      },
    },
  ]
}
