import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import type { ErrorReport } from '$lib/errors/agent-report'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { ReposError } from '../../../../../modules/repos/errors'
import { reposService } from '../../../../../modules/repos/live'
import { REPOS_MODULE_ID } from '../../../../../modules/repos/manifest'

/**
 * GitHub repos (plan/github-drive.md §1, §2): admin only. The token is pasted
 * here — the admin's own click, checked live with GitHub and sealed on the
 * server — never through a kernel tool, the chat or an approval. Nothing on
 * this page returns the token, only its last four characters.
 */

async function requireAdmin(locals: App.Locals): Promise<{ userId: string }> {
  const user = locals.user
  if (!user) throw redirect(302, '/login')
  if (!(await isUserAdmin(user.id)))
    error(403, 'Only the owner or an admin can connect GitHub repos.')
  return { userId: user.id }
}

/** The kernel build wires the plugin's ports (Drive's source writer, the GitHub client). */
async function service() {
  await appKernel()
  return reposService()
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function field(form: FormData, key: string): string {
  const v = form.get(key)
  return typeof v === 'string' ? v.trim() : ''
}

/** What each action does, for the agent report. */
type Ctx = { attempted: string; tool?: string; input?: unknown }

async function act<T extends Record<string, unknown>>(
  action: string,
  ctx: Ctx,
  run: () => Promise<T>,
) {
  try {
    return { action, ok: true as const, ...(await run()) }
  } catch (err) {
    if (err instanceof ReposError)
      return fail(400, { action, ...errorReport(err, { ...ctx, plain: () => err.message }) })
    throw err
  }
}

const refuse = (action: string, sentence: string, ctx: Ctx & { cause: string }) =>
  fail(400, { action, ...refusalReport(sentence, ctx) })

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals)
  const kernel = await appKernel()
  const active = (await kernel.activations.get(REPOS_MODULE_ID)) === true
  const repos = await service()
  const tokens = await repos.tokens()
  return {
    active,
    /** Some repo's latest summary attempt found no model selected. */
    summaryNoModel: tokens.some((t) => t.repos.some((r) => r.summary.problem?.kind === 'no_model')),
    tokens: await Promise.all(
      tokens.map(async (t) => {
        let visible: Array<{
          id: number
          fullName: string
          private: boolean
          archived: boolean
          syncing: boolean
        }> = []
        let visibleError: ErrorReport | null = null
        if (!t.lastError && !t.expired) {
          try {
            visible = (await repos.visibleRepos(t.id)).map((r) => ({
              id: r.id,
              fullName: r.fullName,
              private: r.private,
              archived: r.archived,
              syncing: r.syncing,
            }))
          } catch (err) {
            if (!(err instanceof ReposError)) throw err
            visibleError = errorReport(err, {
              attempted: `Listing the GitHub repos the token of ${t.login} can see (Drive › GitHub)`,
              plain: () => err.message,
            })
          }
        }
        return {
          id: t.id,
          login: t.login,
          last4: t.last4,
          expiresAt: iso(t.expiresAt),
          expiresSoon: t.expiresSoon,
          expired: t.expired,
          lastError: t.lastError,
          createdAt: t.createdAt.toISOString(),
          repos: t.repos.map((r) => ({
            id: r.id,
            repoId: r.repoId,
            fullName: r.fullName,
            defaultBranch: r.defaultBranch,
            copyMode: r.copyMode,
            lastSyncedAt: iso(r.lastSyncedAt),
            nextDueAt: iso(r.nextDueAt),
            lastError: r.lastError,
            pausedUntil: iso(r.pausedUntil),
            summary: {
              writtenAt: iso(r.summary.writtenAt),
              stale: r.summary.stale,
              problem: r.summary.problem
                ? {
                    kind: r.summary.problem.kind,
                    message: r.summary.problem.message,
                    at: r.summary.problem.at.toISOString(),
                  }
                : null,
            },
          })),
          visible,
          visibleError,
        }
      }),
    ),
  }
}

export const actions: Actions = {
  addToken: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const token = field(await request.formData(), 'token')
    const repos = await service()
    // The token itself never goes into a report.
    return act(
      'addToken',
      { attempted: 'Connecting a GitHub token (Drive › GitHub)' },
      async () => ({
        login: (await repos.addToken(me.userId, token)).login,
      }),
    )
  },
  replaceToken: async ({ locals, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    const repos = await service()
    const tokenId = field(form, 'tokenId')
    return act(
      'replaceToken',
      { attempted: `Replacing the GitHub token ${tokenId} (Drive › GitHub)` },
      async () => ({
        login: (await repos.replaceToken(tokenId, field(form, 'token'))).login,
      }),
    )
  },
  removeToken: async ({ locals, request }) => {
    await requireAdmin(locals)
    const tokenId = field(await request.formData(), 'tokenId')
    const repos = await service()
    return act(
      'removeToken',
      { attempted: `Removing the GitHub token ${tokenId} (Drive › GitHub)` },
      async () => await repos.removeToken(tokenId),
    )
  },
  setRepo: async ({ locals, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    const repoId = Number(field(form, 'repoId'))
    const attempted = 'Ticking or unticking a GitHub repo to sync into Drive (Drive › GitHub)'
    if (!Number.isSafeInteger(repoId) || repoId <= 0)
      return refuse('setRepo', 'Pick a repo from the list.', {
        attempted,
        cause: `repoId "${field(form, 'repoId')}" is not a positive integer.`,
      })
    const syncing = field(form, 'syncing') === 'true'
    const tokenId = field(form, 'tokenId')
    const repos = await service()
    return act('setRepo', { attempted, input: { tokenId, repoId, syncing } }, async () => ({
      ...(await repos.setRepo(tokenId, repoId, syncing)),
      syncing,
    }))
  },
  /** All files or docs only (plan/github-drive-full-mirror.md §6); the same as the tool repos.set_copy_mode. */
  setCopyMode: async ({ locals, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    const repoId = Number(field(form, 'repoId'))
    const attempted = 'Choosing what a synced GitHub repo copies into Drive (Drive › GitHub)'
    if (!Number.isSafeInteger(repoId) || repoId <= 0)
      return refuse('setCopyMode', 'Pick a repo from the list.', {
        attempted,
        cause: `repoId "${field(form, 'repoId')}" is not a positive integer.`,
      })
    const mode = field(form, 'mode')
    if (mode !== 'all' && mode !== 'docs')
      return refuse('setCopyMode', 'Choose all files or docs only.', {
        attempted,
        cause: `mode "${mode}" is neither "all" nor "docs".`,
      })
    const repos = await service()
    return act(
      'setCopyMode',
      { attempted, tool: 'repos.set_copy_mode', input: { repoId, mode } },
      async () => await repos.setCopyMode(repoId, mode),
    )
  },
  syncNow: async ({ locals, request }) => {
    await requireAdmin(locals)
    const sourceId = field(await request.formData(), 'sourceId')
    const repos = await service()
    return act(
      'syncNow',
      { attempted: 'Syncing a GitHub repo into Drive now (Drive › GitHub)', input: { sourceId } },
      async () => {
        const out = await repos.syncNow({ sourceId })
        return { fullName: out.fullName, status: out.outcome.status }
      },
    )
  },
}
