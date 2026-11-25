import type { VoiceSource } from '../voice'
import type { MaterialLogo } from './document'
import type { ToolDescriptor } from '$lib/kernel/types'
import { defaultBrandStore, type BrandStore } from '../store'
import { exportMaterial, type MaterialRenderer } from './export'
import { MATERIAL_FORMAT_IDS, exportOf, formatById, sizeLabel } from './formats'
import { liveMaterialChat, suggestMaterialTexts, type MaterialChat } from './texts'
import { MATERIAL_COPY_LIMITS, materialExportInputSchema, materialTextInputSchema } from './types'

/**
 * Kernel tools for Brand › Material (Contribute 288dc1d2): export a piece
 * print-ready (the same service as the tab's Download button) and have the
 * AI write its texts in the brand voice (the tab's "Write texts"). Both save
 * nothing, so both are reads; any member works with the company's material,
 * the brain too, as them.
 */

export type BrandMaterialToolDeps = {
  brand?: VoiceSource & Pick<BrandStore, 'findActiveVisualSet'>
  chat?: MaterialChat
  /** The company logo (Settings → Company); live: the company profile's logo bytes. */
  logo?: () => Promise<MaterialLogo | null>
  render?: MaterialRenderer
}

async function liveLogo(): Promise<MaterialLogo | null> {
  const { currentCompanyLogo } = await import('$lib/server/brand/material')
  return currentCompanyLogo()
}

const catalog = MATERIAL_FORMAT_IDS.map((id) => {
  const f = formatById(id)
  return `${id} (${f.label}, ${sizeLabel(f)}, ${exportOf(f).kind.toUpperCase()})`
}).join('; ')

export function createBrandMaterialTools(deps: BrandMaterialToolDeps = {}): ToolDescriptor[] {
  const brand = () => deps.brand ?? defaultBrandStore()
  const chat = deps.chat ?? liveMaterialChat
  const logo = deps.logo ?? liveLogo
  const permission = { roles: ['admin', 'member', 'agent'] }

  return [
    {
      name: 'brand.material_export',
      module: 'brand',
      summary: `Export a piece of brand material print-ready, in the company's active style with the company logo (Brand › Material): formatId — ${catalog} — mode light|dark (default light), headline (at most ${MATERIAL_COPY_LIMITS.headline}), body and cta for flyers, banners and posters; merch takes the headline as its slogan only (at most ${MATERIAL_COPY_LIMITS.slogan}). logo: false leaves the logo off. Returns { filename, mime, sizeBytes, logo, dataB64 } — the file as base64 (to hand on, e.g. drive.upload). Saves nothing. For the copy, brand.material_text_suggest writes variants in the brand voice.`,
      auditClass: 'read',
      inputSchema: materialExportInputSchema,
      permission,
      handler: async (_ctx, input) => {
        const { bytes, ...file } = await exportMaterial({ visualSets: brand(), logo, ...(deps.render ? { render: deps.render } : {}) }, materialExportInputSchema.parse(input))
        return { ...file, dataB64: Buffer.from(bytes).toString('base64') }
      },
    },
    {
      name: 'brand.material_text_suggest',
      module: 'brand',
      summary:
        "Write 3 copy variants for a piece of brand material (Brand › Material) in the company's active brand voice (its examples, lexicon and glossary), sized for the format: { headline, body, cta } each, or { headline } as the slogan for merch. formatId as in brand.material_export; brief says what the piece is about (event, offer, place — the AI invents no facts); locale picks the voice when several are active. Saves nothing: show the variants, let the person pick and edit, then export with brand.material_export.",
      auditClass: 'read',
      inputSchema: materialTextInputSchema,
      permission,
      handler: async (ctx, input) => {
        const i = materialTextInputSchema.parse(input)
        return suggestMaterialTexts(
          { brand: brand(), chat },
          { formatId: i.formatId, userId: ctx.principal.id, ...(i.brief ? { brief: i.brief } : {}), ...(i.locale ? { locale: i.locale } : {}) },
        )
      },
    },
  ]
}
