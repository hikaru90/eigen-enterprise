import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Email › Templates: reusable mails with {{variables}}, sent from the API, the assistant and flows. */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const t = emailPlatform().templates
  const [templates, layouts] = await Promise.all([t.listTemplates(), t.listLayouts()])
  const layoutName = new Map(layouts.map((l) => [l.id, l.name]))
  return {
    templates: templates.map((x) => ({
      id: x.id,
      name: x.name,
      subject: x.subject,
      format: x.format,
      layout: x.layoutId ? (layoutName.get(x.layoutId) ?? null) : null,
      updatedAt: x.updatedAt.toISOString(),
    })),
    layouts: layouts.map((l) => ({ id: l.id, name: l.name, format: l.format })),
  }
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    const out = await act('create', async () => {
      const t = await emailPlatform().templates.createTemplate(
        { name: field(form, 'name'), layoutId: field(form, 'layoutId') || null },
        me.userId,
      )
      return { id: t.id }
    })
    if ('id' in out && typeof out.id === 'string')
      throw redirect(303, `/m/email/templates/${out.id}`)
    return out
  },
}
