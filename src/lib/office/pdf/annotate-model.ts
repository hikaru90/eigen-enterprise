/**
 * The PDF annotation model (plan/phase-office-files.md P3), without pdf-lib
 * or pdf.js: what the viewer stages and draws, and what ./annotate.ts reads
 * from and writes into a file. Coordinates are the page's default user space
 * (points, origin at the bottom left, y up), as ISO 32000-2 §12.5 has them.
 *
 * One geometry (`appearanceOf`) feeds both the appearance stream written into
 * the file and the SVG the viewer draws while annotating, so what is on
 * screen is what every other reader shows.
 */

export type Rgb = [number, number, number]
export type Rect = [number, number, number, number]
export type MarkupKind = 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'
export type AnnotationKind = MarkupKind | 'Text' | 'Ink' | 'FreeText' | 'Square' | 'Circle' | 'Line'
export type LineEnding = 'None' | 'OpenArrow' | 'ClosedArrow'
/** The Review state model (ISO 32000-2 §12.5.6.3, Table 175). */
export type ReviewState = 'None' | 'Accepted' | 'Rejected' | 'Cancelled' | 'Completed'

export const ANNOTATION_KINDS: readonly AnnotationKind[] = [
  'Highlight',
  'Underline',
  'StrikeOut',
  'Squiggly',
  'Text',
  'Ink',
  'FreeText',
  'Square',
  'Circle',
  'Line',
]
export const REVIEW_STATES: readonly ReviewState[] = [
  'None',
  'Accepted',
  'Rejected',
  'Cancelled',
  'Completed',
]
export const LINE_ENDINGS: readonly LineEnding[] = ['None', 'OpenArrow', 'ClosedArrow']

/** What an annotation draws, per kind. */
export type AnnotationShape =
  /** Text markup: one quadrilateral per line of text (8 numbers each, QuadPoints order). */
  | { kind: MarkupKind; quads: number[][] }
  /** A sticky note: its icon's top-left corner. */
  | { kind: 'Text'; at: [number, number] }
  /** Freehand: each stroke a flat list of x, y. */
  | { kind: 'Ink'; paths: number[][]; width: number }
  /** A text box: the box and the size of its text (Helvetica). */
  | { kind: 'FreeText'; rect: Rect; fontSize: number }
  | { kind: 'Square' | 'Circle'; rect: Rect; width: number; fill: Rgb | null }
  | {
      kind: 'Line'
      line: [number, number, number, number]
      width: number
      ends: [LineEnding, LineEnding]
    }

export type ReviewMark = { state: ReviewState; author: string | null; modified: string | null }

/** An annotation as read from the file (or staged): every kind, the ones we draw with a shape. */
export type PdfAnnotation = {
  /** The object's id as pdf.js names it ("12R", "12R1" for generation 1); staged ones: "new:…". */
  id: string
  /** 0-based page index. */
  page: number
  /** A kind this viewer draws and edits, or 'Other' (links, stamps, …: kept as they are). */
  kind: AnnotationKind | 'Other'
  subtype: string
  rect: Rect
  shape: AnnotationShape | null
  color: Rgb | null
  opacity: number
  author: string | null
  contents: string
  modified: string | null
  created: string | null
  /** The annotation this one replies to (/IRT). */
  inReplyTo: string | null
  /** The latest Review state set on it (state annotations are folded in, not listed). */
  review: ReviewMark | null
}

export type NewAnnotation = {
  page: number
  shape: AnnotationShape
  color: Rgb
  opacity: number
  contents?: string
}

export type AnnotationPatch = {
  color?: Rgb
  opacity?: number
  contents?: string
  /** Moves it by dx, dy points. */
  move?: [number, number]
  /** Replaces what it draws (same kind). */
  shape?: AnnotationShape
}

/**
 * One staged change. `key` names a new annotation so later edits (a reply,
 * a move) can refer to it before it has an object number; ids of existing
 * annotations and keys of new ones are used alike.
 */
export type AnnotationEdit =
  | { op: 'add'; key: string; annotation: NewAnnotation }
  | { op: 'reply'; key: string; to: string; contents: string }
  | { op: 'update'; id: string; patch: AnnotationPatch }
  | { op: 'delete'; id: string }
  | { op: 'review'; id: string; state: ReviewState }

/** A change that can't be made, said plainly (the agent tools turn it into an `invalid` error). */
export class PdfEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfEditError'
  }
}

export const NOTE_SIZE = 20
/** Text box padding inside its border, points. */
export const FREE_TEXT_PAD = 4
export const LEADING = 1.2

// ---------------------------------------------------------------------------
// Geometry

export function normRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
}

function bounds(xs: number[], ys: number[], pad: number): Rect {
  return [
    Math.min(...xs) - pad,
    Math.min(...ys) - pad,
    Math.max(...xs) + pad,
    Math.max(...ys) + pad,
  ]
}

/** A quad (QuadPoints order: top-left, top-right, bottom-left, bottom-right) for an axis-aligned box. */
export function quadOf(r: Rect): number[] {
  const [x1, y1, x2, y2] = normRect(r)
  return [x1, y2, x2, y2, x1, y1, x2, y1]
}

/** The annotation rectangle a shape needs (stroke widths and arrowheads included). */
export function rectOf(shape: AnnotationShape): Rect {
  switch (shape.kind) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const xs = shape.quads.flatMap((q) => [q[0]!, q[2]!, q[4]!, q[6]!])
      const ys = shape.quads.flatMap((q) => [q[1]!, q[3]!, q[5]!, q[7]!])
      return bounds(xs, ys, shape.kind === 'Squiggly' ? 2 : 1)
    }
    case 'Text':
      return [shape.at[0], shape.at[1] - NOTE_SIZE, shape.at[0] + NOTE_SIZE, shape.at[1]]
    case 'Ink': {
      const pts = shape.paths.flat()
      return bounds(
        pts.filter((_, i) => i % 2 === 0),
        pts.filter((_, i) => i % 2 === 1),
        shape.width,
      )
    }
    case 'FreeText':
      return normRect(shape.rect)
    case 'Square':
    case 'Circle':
      return normRect(shape.rect)
    case 'Line': {
      const [x1, y1, x2, y2] = shape.line
      const head = shape.ends.some((e) => e !== 'None') ? arrowSize(shape.width) : 0
      return bounds([x1, x2], [y1, y2], shape.width + head)
    }
  }
}

export function moveShape(shape: AnnotationShape, dx: number, dy: number): AnnotationShape {
  const shift = (pts: number[]) => pts.map((v, i) => v + (i % 2 === 0 ? dx : dy))
  switch (shape.kind) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly':
      return { ...shape, quads: shape.quads.map(shift) }
    case 'Text':
      return { ...shape, at: [shape.at[0] + dx, shape.at[1] + dy] }
    case 'Ink':
      return { ...shape, paths: shape.paths.map(shift) }
    case 'FreeText':
    case 'Square':
    case 'Circle':
      return { ...shape, rect: shift(shape.rect) as Rect }
    case 'Line':
      return { ...shape, line: shift(shape.line) as [number, number, number, number] }
  }
}

export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
}

function arrowSize(width: number) {
  return Math.max(6, width * 4)
}

/** What an appearance draws, in page space. */
export type Primitive =
  | {
      t: 'path'
      /** Sub-paths: flat x, y lists. */
      paths: number[][]
      closed: boolean
      fill: Rgb | null
      stroke: Rgb | null
      width: number
      /** Highlights multiply with the page, so the text stays readable. */
      multiply?: boolean
      round?: boolean
    }
  | {
      t: 'ellipse'
      cx: number
      cy: number
      rx: number
      ry: number
      fill: Rgb | null
      stroke: Rgb | null
      width: number
    }
  | { t: 'text'; x: number; y: number; size: number; lines: string[]; color: Rgb }

export type Measure = (text: string, size: number) => number

/** Breaks text into lines no wider than `width` (words kept whole where they fit). */
export function wrapText(text: string, width: number, size: number, measure: Measure): string[] {
  const out: string[] = []
  for (const para of text.split(/\r\n|\r|\n/)) {
    const words = para.split(' ')
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      if (!line || measure(next, size) <= width) {
        line = next
        continue
      }
      out.push(line)
      line = word
    }
    out.push(line)
  }
  return out
}

/** The appearance of an annotation: what its stream draws, in page coordinates. */
export function appearanceOf(
  shape: AnnotationShape,
  color: Rgb,
  contents: string,
  measure: Measure,
): Primitive[] {
  switch (shape.kind) {
    case 'Highlight':
      return [
        {
          t: 'path',
          paths: shape.quads.map((q) => [q[0]!, q[1]!, q[2]!, q[3]!, q[6]!, q[7]!, q[4]!, q[5]!]),
          closed: true,
          fill: color,
          stroke: null,
          width: 0,
          multiply: true,
        },
      ]
    case 'Underline':
    case 'StrikeOut':
      return [
        {
          t: 'path',
          paths: shape.quads.map((q) => {
            const h = Math.abs(q[1]! - q[5]!)
            const at = shape.kind === 'Underline' ? h / 14 : h * 0.45
            return [q[4]!, q[5]! + at, q[6]!, q[7]! + at]
          }),
          closed: false,
          fill: null,
          stroke: color,
          width: lineWidthOf(shape.quads),
        },
      ]
    case 'Squiggly':
      return [
        {
          t: 'path',
          paths: shape.quads.map((q) => {
            const h = Math.abs(q[1]! - q[5]!)
            const amp = Math.max(1, h / 12)
            const step = amp * 2
            const pts: number[] = []
            const [x0, x1, y] = [q[4]!, q[6]!, q[5]! + amp]
            let k = 0
            for (let x = x0; x < x1; x += step, k++) pts.push(x, k % 2 === 0 ? y - amp : y + amp)
            pts.push(x1, k % 2 === 0 ? y - amp : y + amp)
            return pts
          }),
          closed: false,
          fill: null,
          stroke: color,
          width: lineWidthOf(shape.quads) * 0.8,
        },
      ]
    case 'Text': {
      // A speech bubble: a rounded box with a tail, three text lines inside.
      const [x, top] = shape.at
      const s = NOTE_SIZE
      const body = [
        x + 1,
        top - 1,
        x + s - 1,
        top - 1,
        x + s - 1,
        top - s * 0.72,
        x + s * 0.45,
        top - s * 0.72,
        x + s * 0.25,
        top - s + 1,
        x + s * 0.28,
        top - s * 0.72,
        x + 1,
        top - s * 0.72,
      ]
      const lines = [0.24, 0.38, 0.52].map((f) => [x + 4, top - s * f, x + s - 4, top - s * f])
      return [
        { t: 'path', paths: [body], closed: true, fill: color, stroke: [0, 0, 0], width: 0.8 },
        { t: 'path', paths: lines, closed: false, fill: null, stroke: [0, 0, 0], width: 0.8 },
      ]
    }
    case 'Ink':
      return [
        {
          t: 'path',
          paths: shape.paths,
          closed: false,
          fill: null,
          stroke: color,
          width: shape.width,
          round: true,
        },
      ]
    case 'FreeText': {
      const [x1, y1, x2, y2] = normRect(shape.rect)
      const size = shape.fontSize
      const lines = wrapText(contents, x2 - x1 - 2 * FREE_TEXT_PAD, size, measure)
      const out: Primitive[] = [
        {
          t: 'path',
          paths: [[x1 + 0.5, y1 + 0.5, x2 - 0.5, y1 + 0.5, x2 - 0.5, y2 - 0.5, x1 + 0.5, y2 - 0.5]],
          closed: true,
          fill: null,
          stroke: color,
          width: 1,
        },
      ]
      if (contents)
        out.push({
          t: 'text',
          x: x1 + FREE_TEXT_PAD,
          y: y2 - FREE_TEXT_PAD - size * 0.8,
          size,
          lines,
          color,
        })
      return out
    }
    case 'Square': {
      const [x1, y1, x2, y2] = normRect(shape.rect)
      const h = shape.width / 2
      return [
        {
          t: 'path',
          paths: [[x1 + h, y1 + h, x2 - h, y1 + h, x2 - h, y2 - h, x1 + h, y2 - h]],
          closed: true,
          fill: shape.fill,
          stroke: color,
          width: shape.width,
        },
      ]
    }
    case 'Circle': {
      const [x1, y1, x2, y2] = normRect(shape.rect)
      const h = shape.width / 2
      return [
        {
          t: 'ellipse',
          cx: (x1 + x2) / 2,
          cy: (y1 + y2) / 2,
          rx: Math.max(0, (x2 - x1) / 2 - h),
          ry: Math.max(0, (y2 - y1) / 2 - h),
          fill: shape.fill,
          stroke: color,
          width: shape.width,
        },
      ]
    }
    case 'Line': {
      const [x1, y1, x2, y2] = shape.line
      const out: Primitive[] = [
        {
          t: 'path',
          paths: [[x1, y1, x2, y2]],
          closed: false,
          fill: null,
          stroke: color,
          width: shape.width,
          round: true,
        },
      ]
      const heads: Array<[LineEnding, number, number, number, number]> = [
        [shape.ends[0], x1, y1, x2, y2],
        [shape.ends[1], x2, y2, x1, y1],
      ]
      for (const [end, tx, ty, fx, fy] of heads) {
        if (end === 'None') continue
        const a = Math.atan2(ty - fy, tx - fx)
        const len = arrowSize(shape.width)
        const wing = (d: number) => [tx - len * Math.cos(a + d), ty - len * Math.sin(a + d)]
        const [l, r] = [wing(Math.PI / 6), wing(-Math.PI / 6)]
        out.push({
          t: 'path',
          paths: [[l[0]!, l[1]!, tx, ty, r[0]!, r[1]!]],
          closed: end === 'ClosedArrow',
          fill: end === 'ClosedArrow' ? color : null,
          stroke: color,
          width: shape.width,
          round: true,
        })
      }
      return out
    }
  }
}

function lineWidthOf(quads: number[][]) {
  const h = quads.length ? Math.abs(quads[0]![1]! - quads[0]![5]!) : 12
  return Math.max(0.75, h / 14)
}

// ---------------------------------------------------------------------------
// Staging: the same edits the writer applies, on the list the viewer shows

export const isNewKey = (id: string) => id.startsWith('new:')

export function newKey(): string {
  return `new:${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export type EditContext = { author: string; now: Date }

/** Checks a shape a caller hands in (numbers finite, sizes positive). */
export function checkShape(shape: AnnotationShape): void {
  const finite = (ns: number[]) => ns.every((n) => Number.isFinite(n))
  const ok = (() => {
    switch (shape.kind) {
      case 'Highlight':
      case 'Underline':
      case 'StrikeOut':
      case 'Squiggly':
        return shape.quads.length > 0 && shape.quads.every((q) => q.length === 8 && finite(q))
      case 'Text':
        return finite(shape.at)
      case 'Ink':
        return (
          shape.paths.length > 0 &&
          shape.paths.every((p) => p.length >= 2 && p.length % 2 === 0 && finite(p)) &&
          shape.width > 0
        )
      case 'FreeText':
        return finite(shape.rect) && shape.fontSize > 0
      case 'Square':
      case 'Circle':
        return finite(shape.rect) && shape.width >= 0
      case 'Line':
        return finite(shape.line) && shape.width > 0
    }
  })()
  if (!ok) throw new PdfEditError(`That ${kindLabel(shape.kind).toLowerCase()} has no valid shape.`)
}

export function kindLabel(kind: AnnotationKind | 'Other'): string {
  const labels: Record<AnnotationKind | 'Other', string> = {
    Highlight: 'Highlight',
    Underline: 'Underline',
    StrikeOut: 'Strikethrough',
    Squiggly: 'Squiggly underline',
    Text: 'Note',
    Ink: 'Drawing',
    FreeText: 'Text box',
    Square: 'Rectangle',
    Circle: 'Ellipse',
    Line: 'Line',
    Other: 'Annotation',
  }
  return labels[kind]
}

/**
 * The annotations after `edits`, as the writer will leave them (dates are
 * `ctx.now`, the author is `ctx.author`). Throws PdfEditError on an edit
 * that refers to nothing or can't apply.
 */
export function foldEdits(
  list: PdfAnnotation[],
  edits: AnnotationEdit[],
  ctx: EditContext,
): PdfAnnotation[] {
  let out = [...list]
  const now = ctx.now.toISOString()
  const find = (id: string) => {
    const a = out.find((x) => x.id === id)
    if (!a) throw new PdfEditError(`There is no annotation ${id}.`)
    return a
  }
  for (const e of edits) {
    switch (e.op) {
      case 'add': {
        checkShape(e.annotation.shape)
        out.push({
          id: e.key,
          page: e.annotation.page,
          kind: e.annotation.shape.kind,
          subtype: e.annotation.shape.kind,
          rect: rectOf(e.annotation.shape),
          shape: e.annotation.shape,
          color: e.annotation.color,
          opacity: e.annotation.opacity,
          author: ctx.author,
          contents: e.annotation.contents ?? '',
          modified: now,
          created: now,
          inReplyTo: null,
          review: null,
        })
        break
      }
      case 'reply': {
        const to = find(e.to)
        out.push({
          id: e.key,
          page: to.page,
          kind: 'Text',
          subtype: 'Text',
          rect: to.rect,
          shape: { kind: 'Text', at: [to.rect[0], to.rect[3]] },
          color: to.color,
          opacity: 1,
          author: ctx.author,
          contents: e.contents,
          modified: now,
          created: now,
          inReplyTo: to.id,
          review: null,
        })
        break
      }
      case 'update': {
        const a = find(e.id)
        const p = e.patch
        if ((p.color || p.shape) && !a.shape)
          throw new PdfEditError(`A ${a.subtype} annotation can only be moved, not redrawn.`)
        if (p.shape && p.shape.kind !== a.shape?.kind)
          throw new PdfEditError('An annotation keeps its kind.')
        if (p.shape) checkShape(p.shape)
        let shape = p.shape ?? a.shape
        let rect = p.shape ? rectOf(p.shape) : a.rect
        if (p.move) {
          const [dx, dy] = p.move
          shape = shape ? moveShape(shape, dx, dy) : null
          rect = moveRect(rect, dx, dy)
        }
        const next: PdfAnnotation = {
          ...a,
          shape,
          rect,
          color: p.color ?? a.color,
          opacity: p.opacity ?? a.opacity,
          contents: p.contents ?? a.contents,
          modified: now,
        }
        out = out.map((x) => (x.id === a.id ? next : x))
        break
      }
      case 'delete': {
        find(e.id)
        const gone = new Set([e.id])
        // Replies go with what they answer.
        for (let grew = true; grew;) {
          grew = false
          for (const x of out)
            if (x.inReplyTo && gone.has(x.inReplyTo) && !gone.has(x.id)) {
              gone.add(x.id)
              grew = true
            }
        }
        out = out.filter((x) => !gone.has(x.id))
        break
      }
      case 'review': {
        const a = find(e.id)
        out = out.map((x) =>
          x.id === a.id
            ? { ...a, review: { state: e.state, author: ctx.author, modified: now } }
            : x,
        )
        break
      }
    }
  }
  return out
}

/** Notes and markups the comments list shows: everything we model that is not a reply, in page order. */
export function threadsOf(
  list: PdfAnnotation[],
): Array<{ root: PdfAnnotation; replies: PdfAnnotation[] }> {
  const replies = new Map<string, PdfAnnotation[]>()
  for (const a of list)
    if (a.inReplyTo) replies.set(a.inReplyTo, [...(replies.get(a.inReplyTo) ?? []), a])
  const all = (id: string): PdfAnnotation[] =>
    (replies.get(id) ?? [])
      .flatMap((r) => [r, ...all(r.id)])
      .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''))
  return list
    .filter((a) => !a.inReplyTo && a.kind !== 'Other')
    .sort((a, b) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0])
    .map((root) => ({ root, replies: all(root.id) }))
}

// ---------------------------------------------------------------------------
// Values in the file's form

/** A PDF date (§7.9.4, "D:YYYYMMDDHHmmSSOHH'mm") as ISO 8601, or null when it is not one. */
export function parsePdfDate(s: string | null | undefined): string | null {
  if (!s) return null
  const m =
    /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Zz+-])(\d{2})?'?(\d{2})?'?)?/.exec(
      s.trim(),
    )
  if (!m) return null
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', sign, oh = '00', om = '00'] = m
  const utc = Date.UTC(+y!, +mo - 1, +d, +h, +mi, +se)
  if (Number.isNaN(utc)) return null
  const offset =
    !sign || sign === 'Z' || sign === 'z' ? 0 : (sign === '-' ? -1 : 1) * (+oh * 60 + +om)
  return new Date(utc - offset * 60_000).toISOString()
}

/** A date written as a PDF date, in UTC. */
export function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
}

export function rgbHex(c: Rgb): string {
  return `#${c
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

export function hexRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  if (!m) throw new PdfEditError(`“${hex}” is not a colour (use #rrggbb).`)
  return [parseInt(m[1]!, 16) / 255, parseInt(m[2]!, 16) / 255, parseInt(m[3]!, 16) / 255]
}
