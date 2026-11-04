import { describe, expect, it } from 'vitest'
import { brandValues, emailBrandFromCssVars } from './brand'
import { compose, htmlToText, renderTemplate, TemplateRenderError } from './render'
import { STARTER_LAYOUT, STARTER_TEMPLATE } from './starters'
import { escapeHtml, hasOneContentSlot, placeholders, substitute, templateVariables } from './variables'

const brand = emailBrandFromCssVars(null, 'Kindred')

describe('variables', () => {
  it('finds placeholders with and without fallbacks', () => {
    expect(placeholders('Hi {{ firstName | "there" }}, {{link}} {{ brand.primary }}')).toEqual([
      { name: 'firstName', fallback: 'there' },
      { name: 'link', fallback: null },
      { name: 'brand.primary', fallback: null },
    ])
    expect(templateVariables('{{ a }} {{ b | "x" }}', '{{ a | "y" }} {{ content }} {{ brand.font }}')).toEqual([
      { name: 'a', required: true },
      { name: 'b', required: false },
    ])
  })

  it('escapes values in html, not in plain text, and reports every missing name once', () => {
    const html = substitute('<p>{{ name }} {{ name }} {{ missing }}</p>', { name: '<b>Ada & co</b>' }, { escape: true })
    expect(html.output).toBe('<p>&lt;b&gt;Ada &amp; co&lt;/b&gt; &lt;b&gt;Ada &amp; co&lt;/b&gt; {{ missing }}</p>')
    expect(html.missing).toEqual(['missing'])
    expect(substitute('Hi {{ name }}', { name: 'A & B' }, { escape: false }).output).toBe('Hi A & B')
  })

  it('uses the fallback only when no value is given (an empty value is a value)', () => {
    expect(substitute('{{ n | "there" }}', {}, { escape: true }).output).toBe('there')
    expect(substitute('{{ n | "there" }}', { n: '' }, { escape: true }).output).toBe('')
    expect(substitute('{{ n | "say \\"hi\\"" }}', {}, { escape: false }).output).toBe('say "hi"')
  })

  it('never resolves inherited object keys', () => {
    expect(substitute('{{ constructor }}', {}, { escape: true }).missing).toEqual(['constructor'])
  })

  it('a layout has exactly one content slot', () => {
    expect(hasOneContentSlot(STARTER_LAYOUT.body)).toBe(true)
    expect(hasOneContentSlot('<p>{{content}}{{ content }}</p>')).toBe(false)
    expect(escapeHtml(`'"`)).toBe('&#39;&quot;')
  })
})

describe('brand tokens', () => {
  it('without an active set: the app’s own style', () => {
    expect(brand.source).toBe('app_default')
    expect(brandValues(brand)['brand.primary']).toBe('#111111')
    expect(brandValues(brand)['brand.companyName']).toBe('Kindred')
  })

  it('resolves an active set’s oklch colours to hex and its fonts to stacks', () => {
    const b = emailBrandFromCssVars(
      {
        '--primary': 'oklch(0.55 0.2 30)',
        '--primary-foreground': '#fff',
        '--background': 'oklch(0.98 0 0)',
        '--card': 'white',
        '--foreground': 'oklch(0.2 0 0)',
        '--muted': '#eee',
        '--muted-foreground': '#777',
        '--border': '#ddd',
        '--font-sans': '"Geist"',
        '--radius': '0.5rem',
      },
      'Kindred',
    )
    expect(b.source).toBe('visual_set')
    expect(b.tokens.primary).toMatch(/^#[0-9a-f]{6}$/)
    expect(b.tokens.surface).toBe('#ffffff')
    expect(b.tokens.font).toBe(`"Geist", 'Helvetica Neue', Arial, sans-serif`)
    expect(b.tokens.radius).toBe('8px')
  })

  it('an unreadable colour in an active set fails loud', () => {
    expect(() => emailBrandFromCssVars({ '--primary': 'nope' }, null)).toThrow(/--primary/)
  })

  it('an unnamed company leaves brand.companyName missing (not blank)', () => {
    expect(brandValues(emailBrandFromCssVars(null, null))).not.toHaveProperty('brand.companyName')
  })
})

describe('renderTemplate', () => {
  const template = { subject: STARTER_TEMPLATE.subject, format: 'mjml' as const, body: STARTER_TEMPLATE.body, textBody: null }

  it('renders the starter template inside the Brand layout to responsive html with the brand colours', async () => {
    const out = await renderTemplate({ template, layout: STARTER_LAYOUT, variables: { firstName: 'Ada', link: 'https://k.test/start' }, brand })
    expect(out.subject).toBe('Welcome, Ada!')
    expect(out.html).toMatch(/<!doctype html>/i)
    expect(out.html).toContain('Welcome, Ada!')
    expect(out.html).toContain('https://k.test/start')
    expect(out.html).toContain('#111111')
    expect(out.html).toContain('Kindred')
    expect(out.problems).toEqual([])
    expect(out.text).toContain('Welcome, Ada!')
    expect(out.text).toContain('Get started (https://k.test/start)')
  })

  it('a send refuses missing variables, listing them; the preview shows them', async () => {
    const err = await renderTemplate({ template, layout: STARTER_LAYOUT, variables: {}, brand }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TemplateRenderError)
    expect((err as TemplateRenderError).missing).toEqual(['link'])
    const preview = await renderTemplate({ template, layout: STARTER_LAYOUT, variables: {}, brand }, { allowMissing: true })
    expect(preview.missing).toEqual(['link'])
    expect(preview.subject).toBe('Welcome, there!')
  })

  it('html templates skip MJML; an explicit text body wins over the derived one', async () => {
    const out = await renderTemplate({
      template: { subject: 'Hi', format: 'html', body: '<h1>Hi {{ n }}</h1>', textBody: 'Hi {{ n }} (text)' },
      layout: { format: 'html', body: '<div class="wrap">{{ content }}</div>' },
      variables: { n: '<Ada>' },
      brand,
    })
    expect(out.html).toBe('<div class="wrap"><h1>Hi &lt;Ada&gt;</h1></div>')
    expect(out.text).toBe('Hi <Ada> (text)')
  })

  it('a variable value cannot inject into the layout slot or markup', async () => {
    const out = await renderTemplate({
      template: { subject: 's', format: 'html', body: '<p>{{ v }}</p>', textBody: null },
      layout: { format: 'html', body: '<div>{{ content }}</div>' },
      variables: { v: '{{ content }}<script>' },
      brand,
    })
    expect(out.html).toBe('<div><p>{{ content }}&lt;script&gt;</p></div>')
  })

  it('format mismatch and a slotless layout are explained', () => {
    expect(() => compose('x', { format: 'html', body: '{{ content }}' }, 'mjml')).toThrow(/one format/)
    expect(() => compose('x', { format: 'html', body: '<div></div>' }, 'html')).toThrow(/content/)
  })

  it('reports MJML problems in the preview and refuses them for a send', async () => {
    const bad = { subject: 's', format: 'mjml' as const, body: '<mjml><mj-body><mj-section><mj-column><mj-text unknown-attr="x">hi</mj-text></mj-column></mj-section></mj-body></mjml>', textBody: null }
    const preview = await renderTemplate({ template: bad, layout: null, variables: {}, brand }, { allowMissing: true })
    expect(preview.problems.length).toBeGreaterThan(0)
    await expect(renderTemplate({ template: bad, layout: null, variables: {}, brand })).rejects.toThrow(/MJML has errors/)
  })

  it('htmlToText keeps paragraphs and links', () => {
    expect(htmlToText('<p>One</p><p>Two <a href="https://x.co">link</a></p><br>&amp;')).toBe('One\nTwo link (https://x.co)\n\n&')
  })
})
