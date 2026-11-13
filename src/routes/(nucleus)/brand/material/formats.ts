/**
 * Brand material catalog: the kinds of reusable pieces and their standard
 * sizes. Physical formats are in millimetres (print), screen formats in
 * pixels. The preview draws each at its true aspect ratio.
 */
export type MaterialKind = 'flyer' | 'banner' | 'poster' | 'merch'

export type MaterialFormat = {
  id: string
  kind: MaterialKind
  label: string
  width: number
  height: number
  unit: 'mm' | 'px'
}

export const MATERIAL_KINDS: readonly { id: MaterialKind; label: string }[] = [
  { id: 'flyer', label: 'Digital flyer' },
  { id: 'banner', label: 'Banner' },
  { id: 'poster', label: 'Trade-show poster' },
  { id: 'merch', label: 'Merch' },
]

const FORMATS: readonly MaterialFormat[] = [
  { id: 'flyer-a5', kind: 'flyer', label: 'A5 flyer', width: 148, height: 210, unit: 'mm' },
  {
    id: 'banner-social',
    kind: 'banner',
    label: 'Social header',
    width: 1500,
    height: 500,
    unit: 'px',
  },
  {
    id: 'banner-rollup',
    kind: 'banner',
    label: 'Roll-up banner',
    width: 850,
    height: 2000,
    unit: 'mm',
  },
  { id: 'poster-a1', kind: 'poster', label: 'A1 poster', width: 594, height: 841, unit: 'mm' },
  { id: 'poster-a2', kind: 'poster', label: 'A2 poster', width: 420, height: 594, unit: 'mm' },
  {
    id: 'merch-shirt',
    kind: 'merch',
    label: 'T-shirt front',
    width: 300,
    height: 400,
    unit: 'mm',
  },
  { id: 'merch-mug', kind: 'merch', label: 'Mug wrap', width: 200, height: 90, unit: 'mm' },
  { id: 'merch-tote', kind: 'merch', label: 'Tote bag', width: 300, height: 300, unit: 'mm' },
]

export function formatsOf(kind: MaterialKind): MaterialFormat[] {
  return FORMATS.filter((f) => f.kind === kind)
}

export function formatById(id: string): MaterialFormat {
  const format = FORMATS.find((f) => f.id === id)
  if (!format) throw new Error(`unknown material format: ${id}`)
  return format
}

export function sizeLabel(format: MaterialFormat): string {
  return `${format.width} × ${format.height} ${format.unit}`
}
