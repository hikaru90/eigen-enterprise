import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../../access.server'

/** The layout editor: source with its {{ content }} slot, brand tokens, live preview. */
export const load: PageServerLoad = async ({ locals, params }) => {
  await requireMember(locals)
  const p = emailPlatform()
  const layout = await p.store.getLayout(params.id)
  if (!layout) error(404, 'No such layout')
  const [templates, brand] = await Promise.all([
    p.store.templatesUsingLayout(layout.id),
    p.templates.brand(),
  ])
  return {
    layout: { id: layout.id, name: layout.name, format: layout.format, body: layout.body },
    usedBy: templates.map((t) => ({ id: t.id, name: t.name })),
    brand: { source: brand.source, companyName: brand.companyName, tokens: brand.tokens },
  }
}

export const actions: Actions = {
  save: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    return act('save', async () => {
      await emailPlatform().templates.updateLayout(params.id, {
        name: field(form, 'name'),
        format: field(form, 'format'),
        body: String(form.get('body') ?? ''),
      })
      return {}
    })
  },
  delete: async ({ locals, params }) => {
    await requireAdmin(locals)
    const out = await act('delete', async () => {
      await emailPlatform().templates.deleteLayout(params.id)
      return {}
    })
    if ('ok' in out && out.ok === true) throw redirect(303, '/m/email/layouts')
    return out
  },
}
