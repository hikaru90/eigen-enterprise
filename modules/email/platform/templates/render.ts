import type { TemplateFormat } from '$lib/server/db/email.schema'
import { brandValues, type EmailBrand } from './brand'
import { CONTENT_SLOT, hasOneContentSlot, substitute } from './variables'

/**
 * Template rendering (Owlery's render-template-for-send, on MJML + HTML):
 * layout ∘ template → {{variables}} + {{brand.*}} → MJML compile → html, plus
 * the plain-text part. Server only (MJML is loaded lazily).
 */

export type RenderInput = {
  template: { subject: string; format: TemplateFormat; body: string; textBody: string | null }
  layout: { format: TemplateFormat; body: string } | null
  variables: Record<string, string>
  brand: EmailBrand
}

export type RenderOutput = { subject: string; html: string; text: string }

/** Why a template cannot render, in words for the person editing or sending it. */
export class TemplateRenderError extends Error {
  constructor(
    message: string,
    readonly missing: string[] = [],
    readonly problems: string[] = [],
  ) {
    super(message)
    this.name = 'TemplateRenderError'
  }
}

/** Plain text from rendered html: block ends become line breaks, tags go, entities decode. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return text && text !== href ? `${text} (${href})` : href
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Template body inside the layout's {{content}} slot (before variables). */
export function compose(templateBody: string, layout: RenderInput['layout'], format: TemplateFormat): string {
  if (!layout) return templateBody
  if (layout.format !== format) {
    throw new TemplateRenderError(`The layout is ${layout.format.toUpperCase()} but the template is ${format.toUpperCase()}; use one format for both.`)
  }
  if (!hasOneContentSlot(layout.body)) throw new TemplateRenderError('The layout needs exactly one {{content}} placeholder.')
  return layout.body.replace(/\{\{\s*content\s*\}\}/, () => templateBody)
}

/** MJML → html; every validation problem is reported (the preview shows them, a send refuses them). */
async function compileMjml(source: string): Promise<{ html: string; problems: string[] }> {
  const { default: mjml2html } = await import('mjml')
  const out = await mjml2html(source, { validationLevel: 'soft', keepComments: false })
  return { html: out.html, problems: out.errors.map((e) => (e.line ? `Line ${e.line}: ${e.message}` : e.message)) }
}

/**
 * Renders a template for sending or previewing. A send refuses missing
 * variables (listing every one) and MJML problems; the editor preview
 * (`allowMissing`) shows them instead, leaving missing ones visible as {{name}}.
 */
export async function renderTemplate(
  input: RenderInput,
  opts: { allowMissing?: boolean } = {},
): Promise<RenderOutput & { missing: string[]; problems: string[] }> {
  const values = { ...brandValues(input.brand), ...input.variables }
  const composed = compose(input.template.body, input.layout, input.template.format)
  const body = substitute(composed, values, { escape: true, keep: [CONTENT_SLOT] })
  const subject = substitute(input.template.subject, values, { escape: false })
  const text = input.template.textBody === null ? null : substitute(input.template.textBody, values, { escape: false })
  const missing = [...new Set([...body.missing, ...subject.missing, ...(text?.missing ?? [])])]
  if (missing.length > 0 && !opts.allowMissing) {
    throw new TemplateRenderError(`Missing variables: ${missing.join(', ')}. Pass them in "variables" or give them a fallback like {{ ${missing[0]} | "…" }}.`, missing)
  }
  const compiled = input.template.format === 'mjml' ? await compileMjml(body.output) : { html: body.output, problems: [] }
  if (compiled.problems.length > 0 && !opts.allowMissing) {
    throw new TemplateRenderError('The MJML has errors; fix them in the template editor first.', [], compiled.problems)
  }
  return {
    subject: subject.output.replace(/[\r\n]+/g, ' ').trim(),
    html: compiled.html,
    text: text ? text.output : htmlToText(compiled.html),
    missing,
    problems: compiled.problems,
  }
}
