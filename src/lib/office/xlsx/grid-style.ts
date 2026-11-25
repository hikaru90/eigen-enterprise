import type { BorderEdge, CellBorders, CellStyle } from './styles'

/**
 * The grid's CSS for what a cell's format says beyond text and fill: its
 * borders, font family and vertical position.
 *
 * Borders: an edge between two cells can be written on either of them (the
 * left cell's right edge or the right cell's left edge). Each drawn cell
 * draws its own right and bottom edge — its own, else the neighbour's facing
 * one — so every line is drawn once and in place over the gridline; only the
 * first column and row draw their left and top edges themselves.
 */

const LINE: Record<string, { px: number; css: string }> = {
  thin: { px: 1, css: 'solid' },
  hair: { px: 1, css: 'dotted' },
  dotted: { px: 1, css: 'dotted' },
  dashed: { px: 1, css: 'dashed' },
  dashDot: { px: 1, css: 'dashed' },
  dashDotDot: { px: 1, css: 'dashed' },
  slantDashDot: { px: 2, css: 'dashed' },
  medium: { px: 2, css: 'solid' },
  mediumDashed: { px: 2, css: 'dashed' },
  mediumDashDot: { px: 2, css: 'dashed' },
  mediumDashDotDot: { px: 2, css: 'dashed' },
  thick: { px: 3, css: 'solid' },
  double: { px: 3, css: 'double' },
}

/** Automatic and black lines follow the theme's text colour (readable in dark mode), unless the cell has a fill. */
function lineColor(edge: BorderEdge, filled: boolean): string {
  if (!edge.color || (!filled && edge.color.toUpperCase() === '#000000'))
    return 'var(--foreground, currentColor)'
  return edge.color
}

export type Neighbours = {
  /** Borders of the cell to the right (null: none or no cell). */
  right: CellBorders | null
  /** Borders of the cell below. */
  below: CellBorders | null
  firstCol: boolean
  firstRow: boolean
  filled: boolean
}

export function borderCss(own: CellBorders | null, n: Neighbours): string[] {
  const out: string[] = []
  const side = (edge: BorderEdge | null | undefined, prop: string) => {
    if (!edge) return
    const l = LINE[edge.style] ?? LINE.thin!
    out.push(`${prop}: ${l.px}px ${l.css} ${lineColor(edge, n.filled)}`)
  }
  side(own?.right ?? n.right?.left, 'border-right')
  side(own?.bottom ?? n.below?.top, 'border-bottom')
  const shadows: string[] = []
  const inset = (edge: BorderEdge | null | undefined, x: number, y: number) => {
    if (!edge) return
    const l = LINE[edge.style] ?? LINE.thin!
    shadows.push(`inset ${x * l.px}px ${y * l.px}px 0 ${lineColor(edge, n.filled)}`)
  }
  if (n.firstCol) inset(own?.left, 1, 0)
  if (n.firstRow) inset(own?.top, 0, 1)
  if (shadows.length) out.push(`box-shadow: ${shadows.join(', ')}`)
  return out
}

/** The font family, when it differs from the workbook's plain font (names from the file lose CSS syntax characters). */
export function fontFamilyCss(st: CellStyle, plain: CellStyle): string | null {
  const name = st.font.name?.replace(/["'\\;:{}()<>]/g, '').trim()
  if (!name || name === plain.font.name) return null
  return `font-family: "${name}", sans-serif`
}

/** Excel's vertical alignment → where the grid puts the text (justify/distributed: centred). */
export function verticalOf(st: CellStyle): 'top' | 'center' | 'bottom' {
  if (st.vertical === 'top') return 'top'
  if (st.vertical === 'center' || st.vertical === 'justify' || st.vertical === 'distributed')
    return 'center'
  return 'bottom'
}
