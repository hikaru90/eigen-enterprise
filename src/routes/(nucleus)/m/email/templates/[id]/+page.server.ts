import type { Actions, PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { z } from 'zod'
import { emailPlatform } from '../../../../../../../modules/email/platform/service'
import { TemplateError } from '../../../../../../../modules/email/platform/templates/service'
import { act, field, requireAdmin, requireMember } from '../../access.server'

/** The template editor: source, layout, sample values, live preview, test send. */
export const load: PageServerLoad = async ({ locals, params, url }) => {
  await requireMember(locals)
  const t = emailPlatform().templates
  const template = await emailPlatform().store.getTemplate(params.id)
  if (!template) error(404, 'No such template')
  const layouts = await t.listLayouts()
  return {
    template: {
      id: template.id,
      name: template.name,
      subject: template.subject,
      format: template.format,
      body: template.body,
      textBody: template.textBody,
      layoutId: template.layoutId,
      sampleVariables: template.sampleVariables,
    },
    layouts: layouts.map((l) => ({ id: l.id, name: l.name, format: l.format, body: l.body })),
    endpoint: `${url.origin}/api/mail/send`,
  }
}

const sample = z.record(z.string(), z.string())

function draftFrom(form: FormData) {
  let sampleVariables: Record<string, string>
  try {
    sampleVariables = sample.parse(JSON.parse(field(form, 'sampleVariables') || '{}'))
  } catch {
    throw new TemplateError('The sample values must be plain text.')
  }
  return {
    name: field(form, 'name'),
    subject: field(form, 'subject'),
    format: field(form, 'format'),
    body: String(form.get('body') ?? ''),
    textBody: String(form.get('textBody') ?? '') || null,
    layoutId: field(form, 'layoutId') || null,
    sampleVariables,
  }
}

export const actions: Actions = {
  save: async ({ locals, params, request }) => {
    await requireAdmin(locals)
    const form = await request.formData()
    return act('save', async () => {
      await emailPlatform().templates.updateTemplate(params.id, draftFrom(form))
      return {}
    })
  },
  /** Saves, then sends the saved template with the sample values to the signed-in owner. */
  test: async ({ locals, params, request }) => {
    const me = await requireAdmin(locals)
    const form = await request.formData()
    return act('test', async () => {
      const t = emailPlatform().templates
      await t.updateTemplate(params.id, draftFrom(form))
      const out = await t.sendTest(params.id, me.email)
      return { sentTo: me.email, status: out.status }
    })
  },
  delete: async ({ locals, params }) => {
    await requireAdmin(locals)
    await emailPlatform().templates.deleteTemplate(params.id)
    throw redirect(303, '/m/email/templates')
  },
}
