/**
 * The annotation appearances of ./annotate-model.ts as SVG, for the viewer's
 * Annotate mode: the same primitives the file's appearance streams are
 * written from, drawn in page space (the SVG group carries the page's
 * viewport transform, so y is up as in the PDF).
 */
import { rgbHex, type Primitive, type Rgb } from './annotate-model'

const f = (n: number) => String(Math.round(n * 100) / 100)

export type SvgPrimitive =
  | {
      kind: 'path'
      d: string
      fill: string
      stroke: string
      width: number
      round: boolean
      multiply: boolean
    }
  | { kind: 'text'; x: number; y: number; size: number; lines: string[]; fill: string }

const paint = (c: Rgb | null) => (c ? rgbHex(c) : 'none')

export function svgOf(prims: Primitive[]): SvgPrimitive[] {
  return prims.map((p): SvgPrimitive => {
    if (p.t === 'text')
      return { kind: 'text', x: p.x, y: p.y, size: p.size, lines: p.lines, fill: rgbHex(p.color) }
    let d: string
    if (p.t === 'ellipse') {
      const { cx, cy, rx, ry } = p
      d = `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`
    } else {
      d = p.paths
        .map((pts) => {
          let s = ''
          for (let i = 0; i + 1 < pts.length; i += 2)
            s += `${i === 0 ? 'M' : 'L'}${f(pts[i]!)} ${f(pts[i + 1]!)}`
          return p.closed ? `${s}Z` : s
        })
        .join('')
    }
    return {
      kind: 'path',
      d,
      fill: paint(p.fill),
      stroke: paint(p.stroke),
      width: p.width,
      round: p.t === 'path' && !!p.round,
      multiply: p.t === 'path' && !!p.multiply,
    }
  })
}

/** Groups client rectangles of a text selection into one box per line (PDF space boxes in, merged boxes out). */
export function linesOf(
  boxes: Array<[number, number, number, number]>,
): Array<[number, number, number, number]> {
  const sorted = boxes
    .filter((b) => b[2] - b[0] > 0.5 && b[3] - b[1] > 0.5)
    .sort((a, b) => b[3] - a[3] || a[0] - b[0])
  const out: Array<[number, number, number, number]> = []
  for (const b of sorted) {
    const last = out.at(-1)
    const h = Math.min(b[3] - b[1], last ? last[3] - last[1] : Infinity)
    // The same line: the boxes overlap vertically by more than half their height.
    if (last && Math.min(last[3], b[3]) - Math.max(last[1], b[1]) > h / 2) {
      out[out.length - 1] = [
        Math.min(last[0], b[0]),
        Math.min(last[1], b[1]),
        Math.max(last[2], b[2]),
        Math.max(last[3], b[3]),
      ]
    } else out.push([...b])
  }
  return out
}
