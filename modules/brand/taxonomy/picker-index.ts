import { z } from 'zod'
import { REQUIRED_VISUAL_ROLES } from '../store'

/**
 * The precompiled brand-picker index (plan/phase-brand-picker.md §3.2–3.4) —
 * the contract between the token authoring (B2a, writes `styles.json`), the
 * preview renderer (B2b, adds `preview` paths and writes `picker-index.json`),
 * the picker page (B3) and the design-system view (B4).
 *
 * Owner decisions 2026-11-02: every node carries BOTH a light and a dark token
 * set (dark mode is a global switch, not a variant); genres and styles carry
 * their own representative tokens (not borrowed from a child).
 */

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug')

/** One theme's cssVars: every role activation requires, plus any extra shadcn roles. */
export const pickerTokenSetSchema = z
  .record(z.string().min(1), z.string().min(1))
  .superRefine((vars, ctx) => {
    for (const role of REQUIRED_VISUAL_ROLES) {
      if (!(role in vars)) ctx.addIssue({ code: 'custom', message: `missing required role "${role}"` })
    }
  })
export type PickerTokenSet = z.infer<typeof pickerTokenSetSchema>

export const pickerShapeSchema = z.object({
  radius: z.enum(['none', 'xs', 'sm', 'md', 'lg', 'xl', 'pill']),
  density: z.enum(['compact', 'regular', 'airy']),
  elevation: z.enum(['flat', 'subtle', 'layered']),
  border: z.enum(['none', 'hairline', 'bold']),
})

export const pickerNodeSchema = z.object({
  id: slug,
  level: z.enum(['genre', 'style', 'variant']),
  /** null only for genres. */
  parentId: slug.nullable(),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Google Fonts family names (OFL), also present as font-display / font-sans / font-mono in the token sets. */
  fonts: z.object({ heading: z.string().min(1), body: z.string().min(1), mono: z.string().min(1) }),
  shape: pickerShapeSchema,
  tokens: z.object({ light: pickerTokenSetSchema, dark: pickerTokenSetSchema }),
  /** Where the tokens came from: corpus item slug(s) or authored for this taxonomy. */
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('corpus'), slugs: z.array(slug).min(1) }),
    z.object({ kind: z.literal('authored') }),
  ]),
  /** Precompiled preview images, paths under /static (B2b). Absent in styles.json, required in picker-index.json. */
  preview: z.object({ light: z.string().startsWith('/'), dark: z.string().startsWith('/') }).optional(),
})
export type PickerNode = z.infer<typeof pickerNodeSchema>

/** Structural rules across nodes: unique ids, parents exist at the level above, every genre/style has children. */
export function validatePickerNodes(nodes: PickerNode[], opts: { requirePreviews: boolean }): string[] {
  const errors: string[] = []
  const byId = new Map<string, PickerNode>()
  for (const n of nodes) {
    if (byId.has(n.id)) errors.push(`duplicate id "${n.id}"`)
    byId.set(n.id, n)
  }
  const parentLevel = { genre: null, style: 'genre', variant: 'style' } as const
  for (const n of nodes) {
    const want = parentLevel[n.level]
    if (want === null) {
      if (n.parentId !== null) errors.push(`genre "${n.id}" must not have a parent`)
    } else {
      const p = n.parentId === null ? undefined : byId.get(n.parentId)
      if (!p) errors.push(`${n.level} "${n.id}" has unknown parent "${n.parentId}"`)
      else if (p.level !== want) errors.push(`${n.level} "${n.id}" must have a ${want} parent, got ${p.level}`)
    }
    if (n.level !== 'variant' && !nodes.some((c) => c.parentId === n.id)) {
      errors.push(`${n.level} "${n.id}" has no children`)
    }
    if (opts.requirePreviews && !n.preview) errors.push(`node "${n.id}" has no preview`)
  }
  return errors
}

export const pickerIndexSchema = z.object({
  version: z.literal(1),
  nodes: z.array(pickerNodeSchema).min(1),
})
export type PickerIndex = z.infer<typeof pickerIndexSchema>
