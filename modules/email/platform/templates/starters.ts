import type { TemplateFormat } from '$lib/server/db/email.schema'

/**
 * Starting points for a new layout or template (Owlery's starters, as MJML
 * using the Brand tokens). The owner edits from here; nothing is hidden. The
 * company name carries a fallback so a company not named yet can still send.
 */

export const STARTER_LAYOUT: { name: string; format: TemplateFormat; body: string } = {
  name: 'Brand',
  format: 'mjml',
  body: `<mjml>
  <mj-head>
    <mj-attributes>
      <mj-all font-family="{{ brand.font }}" />
      <mj-text color="{{ brand.foreground }}" font-size="15px" line-height="1.6" />
      <mj-button background-color="{{ brand.primary }}" color="{{ brand.primaryForeground }}" border-radius="{{ brand.radius }}" font-weight="600" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="{{ brand.background }}">
    <mj-section padding="24px 0 8px">
      <mj-column>
        <mj-text font-family="{{ brand.headingFont }}" font-size="18px" font-weight="700">{{ brand.companyName | "" }}</mj-text>
      </mj-column>
    </mj-section>
    <mj-wrapper background-color="{{ brand.surface }}" border-radius="{{ brand.radius }}" padding="8px 0">
      {{ content }}
    </mj-wrapper>
    <mj-section padding="16px 0 32px">
      <mj-column>
        <mj-text color="{{ brand.mutedForeground }}" font-size="12px" align="center">
          You get this email from {{ brand.companyName | "us" }}.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`,
}

export const STARTER_TEMPLATE: { name: string; subject: string; format: TemplateFormat; body: string; sampleVariables: Record<string, string> } = {
  name: 'Welcome',
  subject: 'Welcome, {{ firstName | "there" }}!',
  format: 'mjml',
  body: `<mj-section>
  <mj-column>
    <mj-text font-size="22px" font-weight="700" font-family="{{ brand.headingFont }}">Welcome, {{ firstName | "there" }}!</mj-text>
    <mj-text>Thanks for signing up. Everything you need is one click away.</mj-text>
    <mj-button href="{{ link }}">Get started</mj-button>
  </mj-column>
</mj-section>`,
  sampleVariables: { firstName: 'Ada', link: 'https://example.com' },
}

/** A bare body for a template without a layout (a full MJML document). */
export function standaloneStarter(format: TemplateFormat): string {
  return format === 'mjml'
    ? `<mjml>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text>Hello {{ firstName | "there" }},</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`
    : `<p>Hello {{ firstName | "there" }},</p>`
}
