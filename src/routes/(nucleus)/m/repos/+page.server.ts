import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'
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
  if (!(await isUserAdmin(user.id))) error(403, 'Only the owner or an admin can connect GitHub repos.')
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

async function act<T extends Record<string, unknown>>(action: string, run: () => Promise<T>) {
  try {
    return { action, ok: true as const, ...(await run()) }
  } catch (err) {
    if (err instanceof ReposError) return fail(400, { action, error: err.message })
    throw err
  }
}

export const load: PageServerLoad = async ({ locals }) => {
  await requireAdmin(locals)
  const kernel = await appKernel()
  const active = (await kernel.activations.get(REPOS_MODULE_ID)) === true
  const repos = await service()
  const tokens = await repos.tokens()
  return {
    active,
    tokens: await Promise.all(
      tokens.map(async (t) => {
        let visible: Array<{ id: number; fullName: string; private: boolean; archived: boolean; syncing: boolean }> = []
        let visibleError: string | null = null
        if (!t.lastError && !t.expired) {
          try {
            visible = (await repos.visibleRepos(t.id)).map((r) => ({ id: r.id, fullName: r.fullName, private: r.private, archived: r.archived, syncing: r.syncing }))
          } catch (err) {
            if (!(err instanceof ReposError)) throw err
            visibleError = err.message
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
            lastSyncedAt: iso(r.lastSyncedAt),
            nextDueAt: iso(r.nextDueAt),
            lastError: r.lastError,
            pausedUntil: iso(r.pausedUntil),
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
    return act('addToken', async () => ({ login: (await repos.addToken(me.userId, token)).login }))
  },
  replaceToken: async ({ locals, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    const repos = await service()
    return act('replaceToken', async () => ({ login: (await repos.replaceToken(field(form, 'tokenId'), field(form, 'token'))).login }))
  },
  removeToken: async ({ locals, request }) => {
    await requireAdmin(locals)
    const tokenId = field(await request.formData(), 'tokenId')
    const repos = await service()
    return act('removeToken', async () => await repos.removeToken(tokenId))
  },
  setRepo: async ({ locals, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    const repoId = Number(field(form, 'repoId'))
    if (!Number.isSafeInteger(repoId) || repoId <= 0) return fail(400, { action: 'setRepo', error: 'Pick a repo from the list.' })
    const syncing = field(form, 'syncing') === 'true'
    const repos = await service()
    return act('setRepo', async () => ({ ...(await repos.setRepo(field(form, 'tokenId'), repoId, syncing)), syncing }))
  },
  syncNow: async ({ locals, request }) => {
    await requireAdmin(locals)
    const sourceId = field(await request.formData(), 'sourceId')
    const repos = await service()
    return act('syncNow', async () => {
      const out = await repos.syncNow({ sourceId })
      return { fullName: out.fullName, status: out.outcome.status }
    })
  },
}
