import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { z } from 'zod'
import { isUserAdmin } from '$lib/server/auth/user-role'
import { defaultRoadmapStore } from '../../../../../../../modules/orchestrator/roadmap/store'

/**
 * Memory → Projects → Roadmap (P-4): the company's system project. Its tasks
 * are the roadmap items — planned / in progress / shipped — shown as a board.
 * The owner and admins add, edit and move items; members read. The agent
 * edits the same tasks through the roadmap.* kernel tools. A static route, so
 * it wins over [entityId]; the project's uuid URL redirects here.
 */
export const load: PageServerLoad = async ({ locals, depends }) => {
  if (!locals.user) throw redirect(302, '/login')
  depends('memory:roadmap')
  const store = defaultRoadmapStore()
  return {
    items: await store.list(),
    canEdit: await isUserAdmin(locals.user.id),
  }
}

const status = z.enum(['planned', 'in_progress', 'shipped'])
const kind = z.enum(['feature', 'fix', 'chore'])

const addInput = z.object({
  title: z.string().trim().min(1, 'Give the item a title.'),
  detail: z.string().trim().default(''),
  kind: kind.default('feature'),
  status: status.default('planned'),
})

const updateInput = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1, 'Give the item a title.').optional(),
  detail: z.string().trim().optional(),
  kind: kind.optional(),
  status: status.optional(),
})

/** Present, non-empty form fields only (an absent field means "unchanged"). */
function fields(form: FormData, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of names) {
    const v = form.get(name)
    if (typeof v === 'string' && (v !== '' || name === 'detail')) out[name] = v
  }
  return out
}

async function guard(locals: App.Locals) {
  if (!locals.user) throw redirect(302, '/login')
  if (!(await isUserAdmin(locals.user.id))) {
    return fail(403, { error: 'Only the owner and admins can change the roadmap.' })
  }
  return null
}

export const actions: Actions = {
  add: async ({ locals, request }) => {
    const denied = await guard(locals)
    if (denied) return denied
    const parsed = addInput.safeParse(
      fields(await request.formData(), ['title', 'detail', 'kind', 'status']),
    )
    if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message })
    await defaultRoadmapStore().create(parsed.data)
    return { ok: true }
  },
  update: async ({ locals, request }) => {
    const denied = await guard(locals)
    if (denied) return denied
    const parsed = updateInput.safeParse(
      fields(await request.formData(), ['id', 'title', 'detail', 'kind', 'status']),
    )
    if (!parsed.success) return fail(400, { error: parsed.error.issues[0].message })
    const { id, ...patch } = parsed.data
    await defaultRoadmapStore().update(id, patch)
    return { ok: true }
  },
}
