import { z } from 'zod'
import { MATERIAL_FORMAT_IDS, type MaterialFormat } from './formats'

/**
 * Brand material copy and its limits, shared by the export, the AI text
 * suggestions and the Material tab. Merch carries one slogan (the headline
 * field) and no body or button.
 */

export const MATERIAL_COPY_LIMITS = { headline: 90, body: 300, cta: 40, slogan: 60 } as const

export class MaterialError extends Error {
  constructor(
    readonly code: 'not_found' | 'invalid' | 'unavailable' | 'upstream',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'MaterialError'
  }
}

export const materialFormatIdSchema = z.enum(MATERIAL_FORMAT_IDS as [string, ...string[]])
export const materialModeSchema = z.enum(['light', 'dark'])

export type MaterialCopy = { headline: string; body?: string; cta?: string }

export const materialCopySchema = z
  .object({
    headline: z.string().trim().min(1).max(MATERIAL_COPY_LIMITS.headline),
    body: z.string().trim().max(MATERIAL_COPY_LIMITS.body).optional(),
    cta: z.string().trim().max(MATERIAL_COPY_LIMITS.cta).optional(),
  })
  .strict()

/** The copy checked against the format: merch takes only a slogan (within the slogan limit). */
export function checkCopyFor(format: MaterialFormat, copy: MaterialCopy): MaterialCopy {
  if (format.kind !== 'merch') return copy
  if (copy.body || copy.cta) {
    throw new MaterialError('invalid', 'Merch carries only a slogan (the headline): leave body and cta out.')
  }
  if (copy.headline.length > MATERIAL_COPY_LIMITS.slogan) {
    throw new MaterialError('invalid', `A merch slogan has at most ${MATERIAL_COPY_LIMITS.slogan} characters.`)
  }
  return { headline: copy.headline }
}

export const materialExportInputSchema = z
  .object({
    formatId: materialFormatIdSchema,
    mode: materialModeSchema.default('light'),
    headline: materialCopySchema.shape.headline,
    body: materialCopySchema.shape.body,
    cta: materialCopySchema.shape.cta,
    /** Place the company logo (Settings → Company) on the piece; default true. */
    logo: z.boolean().default(true),
  })
  .strict()

export type MaterialExportInput = z.input<typeof materialExportInputSchema>

export const materialTextInputSchema = z
  .object({
    formatId: materialFormatIdSchema,
    brief: z.string().trim().max(500).optional(),
    locale: z.string().min(2).max(35).optional(),
  })
  .strict()

export type MaterialTextInput = z.infer<typeof materialTextInputSchema>
