import { createHash } from 'node:crypto'
import {
  pickerIndexSchema,
  validatePickerNodes,
  type PickerIndex,
  type PickerNode,
} from '../picker-index'
import { copyForGenre } from './copy'
import { renderPreviewHtml, type PreviewMode } from './render'

export {
  renderPreviewHtml,
  googleFontsUrl,
  previewVars,
  PREVIEW_WIDTH,
  PREVIEW_HEIGHT,
} from './render'
export type { PreviewMode } from './render'
export { copyForGenre, GENRE_COPY, DEFAULT_COPY, type PreviewCopy } from './copy'

export const PREVIEW_MODES: readonly PreviewMode[] = ['light', 'dark']

/** Walk parents up to the genre (nodes are validated, so the walk terminates). */
export function genreIdOf(node: PickerNode, byId: Map<string, PickerNode>): string {
  let n: PickerNode | undefined = node
  for (let i = 0; n && n.level !== 'genre' && i < 3; i++)
    n = n.parentId ? byId.get(n.parentId) : undefined
  return n?.id ?? node.id
}

/** The exact HTML for every node × mode (what gets screenshotted). */
export function previewDocuments(
  nodes: PickerNode[],
): { node: PickerNode; mode: PreviewMode; html: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return nodes.flatMap((node) =>
    PREVIEW_MODES.map((mode) => ({
      node,
      mode,
      html: renderPreviewHtml(node, mode, copyForGenre(genreIdOf(node, byId))),
    })),
  )
}

/** Content hash of a rendered document (+ a renderer version) — the skip-unchanged cache key. */
export function previewHash(html: string, rendererVersion = '1'): string {
  return createHash('sha256').update(`${rendererVersion}\n${html}`).digest('hex').slice(0, 16)
}

export function previewPath(id: string, mode: PreviewMode, ext: 'webp' | 'png' = 'webp'): string {
  return `/brand-previews/${id}-${mode}.${ext}`
}

/**
 * styles.json → picker-index.json: parse, attach preview paths, validate
 * (schema + structure with requirePreviews). Throws with every error listed.
 */
export function buildPickerIndex(styles: unknown, ext: 'webp' | 'png' = 'webp'): PickerIndex {
  const parsed = pickerIndexSchema.parse(styles)
  const index: PickerIndex = {
    version: 1,
    nodes: parsed.nodes.map((n) => ({
      ...n,
      preview: { light: previewPath(n.id, 'light', ext), dark: previewPath(n.id, 'dark', ext) },
    })),
  }
  const checked = pickerIndexSchema.parse(index)
  const errors = validatePickerNodes(checked.nodes, { requirePreviews: true })
  if (errors.length) throw new Error(`picker index invalid:\n- ${errors.join('\n- ')}`)
  return checked
}
