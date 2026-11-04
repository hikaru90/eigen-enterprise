import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Email › Flows: automations that mail people when they join a list. */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const a = emailPlatform().audience
  const [flows, lists] = await Promise.all([a.listFlows(), a.listLists()])
  const listName = new Map(lists.map((l) => [l.id, l.name]))
  return {
    flows: flows.map((f) => ({
      id: f.id,
      name: f.name,
      status: f.status,
      trigger: f.triggerListId ? (listName.get(f.triggerListId) ?? null) : null,
      steps: Array.isArray(f.steps) ? f.steps.length : 0,
      active: f.active,
      completed: f.completed,
    })),
    lists: lists.map((l) => ({ id: l.id, name: l.name })),
  }
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    const out = await act('create', async () => {
      const f = await emailPlatform().audience.createFlow({ name: field(form, 'name'), triggerListId: field(form, 'listId') || null }, me.userId)
      return { id: f.id }
    })
    if ('id' in out && typeof out.id === 'string') throw redirect(303, `/m/email/flows/${out.id}`)
    return out
  },
}
