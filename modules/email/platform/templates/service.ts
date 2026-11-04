import type { OwleryService } from '../../owlery/service'
import type { EmailStore, LayoutRow, TemplateRow } from '../store'
import type { EmailBrand } from './brand'
import { TEMPLATE_FORMATS, type TemplateFormat } from '$lib/server/db/email.schema'
import type { SendMailInput, SendMailResult } from '$lib/server/mail/company-mail'
import { renderTemplate, TemplateRenderError, type RenderOutput } from './render'
import { STARTER_LAYOUT, STARTER_TEMPLATE, standaloneStarter } from './starters'
import { hasOneContentSlot, templateVariables } from './variables'

/**
 * Templates and layouts (plan/phase-polish-1.md P-6, E-P2): CRUD, preview,
 * test send, and the send-by-template path every caller (API, assistant,
 * flows) uses — rendered here, delivered through OwleryService.send.
 */

export class TemplateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateError'
  }
}

export type TemplateDraft = {
  name: string
  subject: string
  /** mjml | html — checked here, so form and JSON input pass through as text. */
  format: string
  body: string
  textBody: string | null
  layoutId: string | null
  sampleVariables: Record<string, string>
}

export type TemplateSendInput = Omit<SendMailInput, 'subject' | 'html' | 'text' | 'templateId'> & {
  templateId: string
  variables: Record<string, string>
}

export type TemplateServiceDeps = {
  store: EmailStore
  owlery: OwleryService
  brand: () => Promise<EmailBrand>
}

function checkFormat(format: string): TemplateFormat {
  if (!(TEMPLATE_FORMATS as readonly string[]).includes(format)) throw new TemplateError('The format is MJML or HTML.')
  return format as TemplateFormat
}

export class TemplateService {
  constructor(private readonly deps: TemplateServiceDeps) {}

  brand(): Promise<EmailBrand> {
    return this.deps.brand()
  }

  // ─── layouts ───────────────────────────────────────────────────────────────

  listLayouts(): Promise<LayoutRow[]> {
    return this.deps.store.listLayouts()
  }

  async getLayout(id: string): Promise<LayoutRow> {
    const l = await this.deps.store.getLayout(id)
    if (!l) throw new TemplateError('That layout does not exist (any more).')
    return l
  }

  /** A new layout, starting from the Brand starter. */
  createLayout(name: string, createdBy: string): Promise<LayoutRow> {
    return this.deps.store.insertLayout({
      name: name.trim() || STARTER_LAYOUT.name,
      format: STARTER_LAYOUT.format,
      body: STARTER_LAYOUT.body,
      createdBy,
    })
  }

  async updateLayout(id: string, patch: { name: string; format: string; body: string }): Promise<LayoutRow> {
    const format = checkFormat(patch.format)
    if (!patch.name.trim()) throw new TemplateError('Give the layout a name.')
    if (!hasOneContentSlot(patch.body)) throw new TemplateError('A layout needs exactly one {{ content }} placeholder: that is where each template goes.')
    const users = (await this.deps.store.templatesUsingLayout(id)).filter((t) => t.format !== format)
    if (users.length > 0) {
      throw new TemplateError(`${users.map((t) => t.name).join(', ')} ${users.length === 1 ? 'is' : 'are'} ${users[0]!.format.toUpperCase()}; a layout and its templates share one format.`)
    }
    return this.deps.store.updateLayout(id, { name: patch.name.trim(), format, body: patch.body })
  }

  async deleteLayout(id: string): Promise<void> {
    const users = await this.deps.store.templatesUsingLayout(id)
    if (users.length > 0) throw new TemplateError(`Still used by ${users.map((t) => t.name).join(', ')}. Pick another layout for them first.`)
    await this.deps.store.deleteLayout(id)
  }

  // ─── templates ─────────────────────────────────────────────────────────────

  listTemplates(): Promise<TemplateRow[]> {
    return this.deps.store.listTemplates()
  }

  async getTemplate(id: string): Promise<TemplateRow> {
    const t = await this.deps.store.getTemplate(id)
    if (!t) throw new TemplateError('That template does not exist (any more).')
    return t
  }

  /** A new template from the Welcome starter, inside the given layout (or standalone). */
  async createTemplate(input: { name: string; layoutId: string | null }, createdBy: string): Promise<TemplateRow> {
    const layout = input.layoutId ? await this.getLayout(input.layoutId) : null
    const format = layout?.format ?? STARTER_TEMPLATE.format
    return this.deps.store.insertTemplate({
      name: input.name.trim() || STARTER_TEMPLATE.name,
      subject: STARTER_TEMPLATE.subject,
      format,
      body: layout ? (format === 'mjml' ? STARTER_TEMPLATE.body : '<p>Welcome, {{ firstName | "there" }}!</p>') : standaloneStarter(format),
      textBody: null,
      layoutId: layout?.id ?? null,
      sampleVariables: STARTER_TEMPLATE.sampleVariables,
      createdBy,
    })
  }

  private async validateDraft(d: TemplateDraft): Promise<{ format: TemplateFormat; layout: LayoutRow | null }> {
    const format = checkFormat(d.format)
    if (!d.name.trim()) throw new TemplateError('Give the template a name.')
    if (!d.subject.trim()) throw new TemplateError('The subject is required.')
    if (!d.body.trim()) throw new TemplateError('The body is empty.')
    const layout = d.layoutId ? await this.getLayout(d.layoutId) : null
    if (layout && layout.format !== format) throw new TemplateError(`The layout “${layout.name}” is ${layout.format.toUpperCase()}; write the template in ${layout.format.toUpperCase()} too.`)
    return { format, layout }
  }

  async updateTemplate(id: string, d: TemplateDraft): Promise<TemplateRow> {
    const { format, layout } = await this.validateDraft(d)
    return this.deps.store.updateTemplate(id, {
      name: d.name.trim(),
      subject: d.subject,
      format,
      body: d.body,
      textBody: d.textBody?.trim() ? d.textBody : null,
      layoutId: layout?.id ?? null,
      sampleVariables: d.sampleVariables,
    })
  }

  async deleteTemplate(id: string): Promise<void> {
    await this.deps.store.deleteTemplate(id)
  }

  /** The variables a template expects (for the editor, the API page and the assistant). */
  async variablesOf(t: TemplateRow): Promise<{ name: string; required: boolean }[]> {
    const layout = t.layoutId ? await this.deps.store.getLayout(t.layoutId) : null
    return templateVariables(t.subject, t.body, t.textBody ?? '', layout?.body ?? '')
  }

  /** Renders an unsaved draft for the live preview: missing variables and MJML problems are shown, not thrown. */
  async preview(d: TemplateDraft, variables: Record<string, string>) {
    const { format, layout } = await this.validateDraft({ ...d, name: d.name || 'preview', subject: d.subject || ' ' })
    return renderTemplate(
      { template: { subject: d.subject, format, body: d.body, textBody: d.textBody?.trim() ? d.textBody : null }, layout, variables, brand: await this.deps.brand() },
      { allowMissing: true },
    )
  }

  /** Renders a layout around a stand-in block, for the layout editor's preview. */
  async previewLayout(format: string, body: string) {
    const f = checkFormat(format)
    if (!hasOneContentSlot(body)) throw new TemplateError('A layout needs exactly one {{ content }} placeholder: that is where each template goes.')
    const sample =
      f === 'mjml'
        ? '<mj-section><mj-column><mj-text font-size="20px" font-weight="700">A template’s content goes here</mj-text><mj-text>Every template that uses this layout appears here, in the content slot.</mj-text></mj-column></mj-section>'
        : '<h2>A template’s content goes here</h2><p>Every template that uses this layout appears here, in the content slot.</p>'
    return renderTemplate(
      { template: { subject: 'Preview', format: f, body: sample, textBody: null }, layout: { format: f, body }, variables: {}, brand: await this.deps.brand() },
      { allowMissing: true },
    )
  }

  /** Renders a saved template for sending; refuses missing variables and MJML problems (TemplateRenderError). */
  async render(templateId: string, variables: Record<string, string>): Promise<RenderOutput> {
    const t = await this.getTemplate(templateId)
    const layout = t.layoutId ? await this.getLayout(t.layoutId) : null
    const out = await renderTemplate({ template: t, layout, variables, brand: await this.deps.brand() })
    return { subject: out.subject, html: out.html, text: out.text }
  }

  /** Send by template id: rendered here, delivered (and logged) by the one send path. */
  async send(input: TemplateSendInput): Promise<SendMailResult> {
    const { templateId, variables, ...rest } = input
    const r = await this.render(templateId, variables)
    return this.deps.owlery.send({ ...rest, source: rest.source ?? 'template', templateId, subject: r.subject, html: r.html, text: r.text })
  }

  /** The editor's "Send me a test": the saved template with its sample values. */
  async sendTest(templateId: string, to: string): Promise<SendMailResult> {
    const t = await this.getTemplate(templateId)
    return this.send({ templateId, variables: t.sampleVariables, to, source: 'test' })
  }
}

export { TemplateRenderError }
