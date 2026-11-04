import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { z } from 'zod'
import { emailPlatform } from '../../../../../../modules/email/platform/service'
import { TemplateError, TemplateRenderError } from '../../../../../../modules/email/platform/templates/service'

/**
 * POST /api/mail/templates/preview — the editors' live preview (signed-in
 * members; nothing is saved or sent). Body: a template draft + variables, or a
 * layout ({ layout: { format, body } }). Answers the rendered subject, html and
 * text, plus the missing variables and MJML problems to show beside it.
 */
const draft = z.object({
  template: z.object({
    name: z.string().default(''),
    subject: z.string(),
    format: z.string(),
    body: z.string(),
    textBody: z.string().nullable().default(null),
    layoutId: z.string().nullable().default(null),
  }),
  variables: z.record(z.string(), z.string()).default({}),
})
const layout = z.object({ layout: z.object({ format: z.string(), body: z.string() }) })

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user) return json({ error: 'You must be signed in.' }, { status: 401 })
  const body = (await request.json().catch(() => null)) as unknown
  const templates = emailPlatform().templates
  try {
    const asLayout = layout.safeParse(body)
    if (asLayout.success) {
      const out = await templates.previewLayout(asLayout.data.layout.format, asLayout.data.layout.body)
      return json({ html: out.html, problems: out.problems, missing: out.missing })
    }
    const parsed = draft.safeParse(body)
    if (!parsed.success) return json({ error: 'Send { template, variables } or { layout }.' }, { status: 400 })
    const { template, variables } = parsed.data
    const out = await templates.preview({ ...template, sampleVariables: variables }, variables)
    return json(out)
  } catch (err) {
    if (err instanceof TemplateError || err instanceof TemplateRenderError) {
      return json({ error: err.message, problems: err instanceof TemplateRenderError ? err.problems : [] }, { status: 422 })
    }
    throw err
  }
}
