import type { Actions, PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { act, field, requireAdmin, requireMember } from '../access.server'

/** Email › Layouts: the brand wrapper (header, footer, styles) templates render inside. */
export const load: PageServerLoad = async ({ locals }) => {
  await requireMember(locals)
  const t = emailPlatform().templates
  const [layouts, templates, brand] = await Promise.all([t.listLayouts(), t.listTemplates(), t.brand()])
  return {
    layouts: layouts.map((l) => ({
      id: l.id,
      name: l.name,
      format: l.format,
      used: templates.filter((x) => x.layoutId === l.id).length,
    })),
    brand: { source: brand.source, companyName: brand.companyName, tokens: brand.tokens },
  }
}

export const actions: Actions = {
  create: async ({ locals, request }) => {
    const me = await requireAdmin(locals)
    const name = field(await request.formData(), 'name')
    const out = await act('create', async () => ({ id: (await emailPlatform().templates.createLayout(name, me.userId)).id }))
    if ('id' in out && typeof out.id === 'string') throw redirect(303, `/m/email/layouts/${out.id}`)
    return out
  },
}
