import type { BrandStore } from '../store'
import { materialDocument, materialFontLinks, type MaterialLogo } from './document'
import { exportOf, formatById, type MaterialFormat } from './formats'
import { renderMaterial, type RenderDeps, type RenderedMaterial } from './render'
import { checkCopyFor, materialExportInputSchema, MaterialError, type MaterialExportInput } from './types'

/**
 * Export one piece of brand material, print-ready (Contribute 288dc1d2): the
 * active visual set's style, the company logo (Settings → Company) unless
 * left off, the given copy — as a PDF at the paper size or a PNG at the
 * pixel / 300 dpi size (formats.ts exportOf). Saves nothing: the bytes go
 * back to whoever asked (the tab downloads them, the agent gets base64).
 */

export type MaterialRenderer = (html: string, format: MaterialFormat, fonts: string[]) => Promise<RenderedMaterial>

export type MaterialExportDeps = {
  visualSets: Pick<BrandStore, 'findActiveVisualSet'>
  /** The company logo's bytes, null when none is set. */
  logo: () => Promise<MaterialLogo | null>
  render?: MaterialRenderer
}

export type MaterialExport = {
  formatId: string
  filename: string
  mime: RenderedMaterial['mime']
  sizeBytes: number
  /** Whether the company logo is on the piece. */
  logo: boolean
  bytes: Uint8Array
}

export const NO_ACTIVE_STYLE_MESSAGE = 'No style is active yet: choose one under Brand first.'

/** `<headline>-<format>.<ext>`: letters and digits of any script, dashes between. */
export function materialFileName(headline: string, format: MaterialFormat, extension: string): string {
  const stem = headline
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60)
    .replace(/-+$/, '')
  return `${stem ? `${stem}-` : ''}${format.id}.${extension}`
}

export const liveRenderer =
  (deps: Omit<RenderDeps, 'fonts'> = {}): MaterialRenderer =>
  (html, format, fonts) =>
    renderMaterial(html, format, { ...deps, fonts })

export async function exportMaterial(deps: MaterialExportDeps, raw: MaterialExportInput): Promise<MaterialExport> {
  const input = materialExportInputSchema.parse(raw)
  const format = formatById(input.formatId)
  const copy = checkCopyFor(format, {
    headline: input.headline,
    ...(input.body ? { body: input.body } : {}),
    ...(input.cta ? { cta: input.cta } : {}),
  })
  const style = await deps.visualSets.findActiveVisualSet()
  if (!style) throw new MaterialError('not_found', NO_ACTIVE_STYLE_MESSAGE)
  const logo = input.logo ? await deps.logo() : null
  const html = materialDocument({
    format,
    mode: input.mode,
    copy,
    style: { name: style.name, cssVars: style.cssVars, darkCssVars: style.darkCssVars },
    logo,
  })
  const fonts = materialFontLinks(style.cssVars).map((f) => f.family)
  const rendered = await (deps.render ?? liveRenderer())(html, format, fonts)
  return {
    formatId: format.id,
    filename: materialFileName(copy.headline, format, exportOf(format).extension),
    mime: rendered.mime,
    sizeBytes: rendered.bytes.byteLength,
    logo: logo !== null,
    bytes: rendered.bytes,
  }
}
