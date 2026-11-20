import { a, attr, children, kids, NS } from './xml'

/**
 * DrawingML shape geometry (ECMA-376 Part 1 §20.1.9): adjust values and
 * guides (a tiny formula language over the shape's width and height) feed
 * path commands. One engine draws both the preset shapes (./presets.ts,
 * definitions written for this reader) and custom geometry from the file.
 */

/** An operand: a guide/built-in name or a number literal. */
type Operand = string

export type PathCmd =
  | { op: 'M' | 'L'; x: Operand; y: Operand }
  | { op: 'A'; wR: Operand; hR: Operand; stAng: Operand; swAng: Operand }
  | { op: 'Q'; x1: Operand; y1: Operand; x: Operand; y: Operand }
  | { op: 'C'; x1: Operand; y1: Operand; x2: Operand; y2: Operand; x: Operand; y: Operand }
  | { op: 'Z' }

/** ST_PathFillMode: how a path is filled (the shading variants darken or lighten the shape's fill). */
export type PathFill = 'none' | 'norm' | 'lighten' | 'lightenLess' | 'darken' | 'darkenLess'

export type GeomPath = { w: number | null; h: number | null; fill: PathFill; stroke: boolean; cmds: PathCmd[] }

export type GeomDef = {
  /** Adjust values with their defaults. */
  av: Record<string, number>
  /** Guides, in evaluation order: [name, formula]. */
  gd: Array<[string, string]>
  /** The text rectangle [l, t, r, b] as operands; null: the whole frame. */
  rect: [Operand, Operand, Operand, Operand] | null
  paths: GeomPath[]
}

export type BuiltPath = { d: string; fill: PathFill; stroke: boolean }
export type BuiltGeometry = { paths: BuiltPath[]; textRect: { l: number; t: number; r: number; b: number } }

export class GeometryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeometryError'
  }
}

const ANGLE = 60000 // angles are in 60000ths of a degree
const rad = (a: number) => (a / ANGLE) * (Math.PI / 180)
const deg60k = (r: number) => (r * 180 * ANGLE) / Math.PI

/** The built-in variables of a w × h shape (§20.1.9.11). */
export function builtins(w: number, h: number): Map<string, number> {
  const ss = Math.min(w, h)
  const m = new Map<string, number>([
    ['w', w], ['h', h], ['l', 0], ['t', 0], ['r', w], ['b', h], ['hc', w / 2], ['vc', h / 2],
    ['ss', ss], ['ls', Math.max(w, h)],
    ['cd2', 10800000], ['cd4', 5400000], ['cd8', 2700000], ['3cd4', 16200000], ['3cd8', 8100000], ['5cd8', 13500000], ['7cd8', 18900000],
  ])
  for (const d of [2, 3, 4, 5, 6, 8, 10, 12, 16, 32]) {
    m.set(`wd${d}`, w / d)
    m.set(`hd${d}`, h / d)
    m.set(`ssd${d}`, ss / d)
  }
  return m
}

function value(op: Operand, vars: Map<string, number>): number {
  const v = vars.get(op)
  if (v !== undefined) return v
  const n = Number(op)
  if (op !== '' && Number.isFinite(n)) return n
  throw new GeometryError(`Shape guide refers to "${op}", which is not defined.`)
}

/** One guide formula ("*\/ w adj 100000"). */
export function evalFormula(fmla: string, vars: Map<string, number>): number {
  const [op, ...args] = fmla.trim().split(/\s+/)
  const [x = 0, y = 0, z = 0] = args.map((arg) => value(arg, vars))
  switch (op) {
    case '*/':
      return z === 0 ? 0 : (x * y) / z
    case '+-':
      return x + y - z
    case '+/':
      return z === 0 ? 0 : (x + y) / z
    case '?:':
      return x > 0 ? y : z
    case 'abs':
      return Math.abs(x)
    case 'at2':
      return deg60k(Math.atan2(y, x))
    case 'cat2':
      return x * Math.cos(Math.atan2(z, y))
    case 'cos':
      return x * Math.cos(rad(y))
    case 'max':
      return Math.max(x, y)
    case 'min':
      return Math.min(x, y)
    case 'mod':
      return Math.sqrt(x * x + y * y + z * z)
    case 'pin':
      return y < x ? x : y > z ? z : y
    case 'sat2':
      return x * Math.sin(Math.atan2(z, y))
    case 'sin':
      return x * Math.sin(rad(y))
    case 'sqrt':
      return Math.sqrt(Math.max(0, x))
    case 'tan':
      return x * Math.tan(rad(y))
    case 'val':
      return x
    default:
      throw new GeometryError(`Unknown shape guide operator "${op}".`)
  }
}

/** All variables of a shape: built-ins, then adjust values (file overrides win), then guides. */
export function guideValues(def: GeomDef, w: number, h: number, overrides: Record<string, string>): Map<string, number> {
  const vars = builtins(w, h)
  for (const [name, dflt] of Object.entries(def.av)) {
    const o = overrides[name]
    vars.set(name, o !== undefined ? evalFormula(o, vars) : dflt)
  }
  // An override for a name the definition does not adjust still becomes a variable (custom geometry).
  for (const [name, fmla] of Object.entries(overrides)) if (!(name in def.av)) vars.set(name, evalFormula(fmla, vars))
  for (const [name, fmla] of def.gd) vars.set(name, evalFormula(fmla, vars))
  return vars
}

const fmt = (n: number) => {
  const r = Math.round(n * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

/** The parametric angle of the point where a ray at visual angle `a` (radians) meets an wR × hR ellipse. */
const param = (a: number, wR: number, hR: number) => Math.atan2(wR * Math.sin(a), hR * Math.cos(a))

/**
 * The SVG paths of a geometry in a w × h frame. Coordinates come out in the
 * frame's own units scaled by `scale` (EMU in, px out).
 */
export function buildGeometry(def: GeomDef, w: number, h: number, overrides: Record<string, string>, scale = 1): BuiltGeometry {
  const vars = guideValues(def, w, h, overrides)
  const paths: BuiltPath[] = []
  for (const path of def.paths) {
    const sx = (path.w ? w / path.w : 1) * scale
    const sy = (path.h ? h / path.h : 1) * scale
    let d = ''
    let cx = 0
    let cy = 0
    let startX = 0
    let startY = 0
    const pt = (x: Operand, y: Operand): [number, number] => [value(x, vars) * sx, value(y, vars) * sy]
    for (const c of path.cmds) {
      if (c.op === 'M' || c.op === 'L') {
        ;[cx, cy] = pt(c.x, c.y)
        if (c.op === 'M') [startX, startY] = [cx, cy]
        d += `${c.op}${fmt(cx)} ${fmt(cy)}`
      } else if (c.op === 'Q') {
        const [x1, y1] = pt(c.x1, c.y1)
        ;[cx, cy] = pt(c.x, c.y)
        d += `Q${fmt(x1)} ${fmt(y1)} ${fmt(cx)} ${fmt(cy)}`
      } else if (c.op === 'C') {
        const [x1, y1] = pt(c.x1, c.y1)
        const [x2, y2] = pt(c.x2, c.y2)
        ;[cx, cy] = pt(c.x, c.y)
        d += `C${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(cx)} ${fmt(cy)}`
      } else if (c.op === 'A') {
        // Angles are visual angles in the path's own space; the parametric angle survives the scaling.
        const pwR = value(c.wR, vars)
        const phR = value(c.hR, vars)
        const wR = pwR * sx
        const hR = phR * sy
        const st = rad(value(c.stAng, vars))
        const sw = rad(value(c.swAng, vars))
        if (wR === 0 || hR === 0) continue
        // The current point sits on the ellipse at the start angle; find the centre.
        const t0 = param(st, pwR, phR)
        const ox = cx - wR * Math.cos(t0)
        const oy = cy - hR * Math.sin(t0)
        const full = Math.abs(sw) >= 2 * Math.PI - 1e-9
        let delta: number
        if (full) delta = Math.sign(sw) * 2 * Math.PI
        else {
          delta = param(st + sw, pwR, phR) - t0
          if (sw > 0) while (delta < 0) delta += 2 * Math.PI
          if (sw < 0) while (delta > 0) delta -= 2 * Math.PI
          // A sweep beyond a half turn keeps its size (param() folds angles into ±π).
          if (Math.abs(sw) > Math.PI && Math.abs(delta) < Math.PI) delta += Math.sign(sw) * 2 * Math.PI
        }
        // SVG arcs cannot draw a full turn: split every arc into pieces of at most a half turn.
        const pieces = Math.max(1, Math.ceil(Math.abs(delta) / Math.PI - 1e-9))
        for (let i = 1; i <= pieces; i++) {
          const t = t0 + (delta * i) / pieces
          const ex = ox + wR * Math.cos(t)
          const ey = oy + hR * Math.sin(t)
          const large = Math.abs(delta / pieces) > Math.PI + 1e-9 ? 1 : 0
          d += `A${fmt(wR)} ${fmt(hR)} 0 ${large} ${delta > 0 ? 1 : 0} ${fmt(ex)} ${fmt(ey)}`
          cx = ex
          cy = ey
        }
      } else {
        d += 'Z'
        cx = startX
        cy = startY
      }
    }
    paths.push({ d, fill: path.fill, stroke: path.stroke })
  }
  const rect = def.rect
  const textRect = rect
    ? { l: value(rect[0], vars) * scale, t: value(rect[1], vars) * scale, r: value(rect[2], vars) * scale, b: value(rect[3], vars) * scale }
    : { l: 0, t: 0, r: w * scale, b: h * scale }
  return { paths, textRect }
}

const FILLS = new Set<PathFill>(['none', 'norm', 'lighten', 'lightenLess', 'darken', 'darkenLess'])

/** Guide overrides of an a:avLst ([name, formula]). */
export function readAvLst(avLst: Element | null): Record<string, string> {
  const out: Record<string, string> = {}
  for (const gd of children(avLst, NS.a, 'gd')) {
    const name = attr(gd, 'name')
    const fmla = attr(gd, 'fmla')
    if (name && fmla) out[name] = fmla
  }
  return out
}

/** a:custGeom (§20.1.9.8) as a definition the engine draws. Its own avLst values become guides. */
export function readCustGeom(el: Element): GeomDef {
  const gd: Array<[string, string]> = [...Object.entries(readAvLst(a(el, 'avLst')))]
  for (const g of children(a(el, 'gdLst'), NS.a, 'gd')) {
    const name = attr(g, 'name')
    const fmla = attr(g, 'fmla')
    if (name && fmla) gd.push([name, fmla])
  }
  const r = a(el, 'rect')
  const rect: GeomDef['rect'] = r ? [attr(r, 'l') ?? 'l', attr(r, 't') ?? 't', attr(r, 'r') ?? 'r', attr(r, 'b') ?? 'b'] : null
  const paths: GeomPath[] = []
  for (const p of children(a(el, 'pathLst'), NS.a, 'path')) {
    const fill = (attr(p, 'fill') ?? 'norm') as PathFill
    const cmds: PathCmd[] = []
    for (const c of kids(p)) {
      if (c.namespaceURI !== NS.a) continue
      const pts = children(c, NS.a, 'pt').map((pt) => [attr(pt, 'x') ?? '0', attr(pt, 'y') ?? '0'] as const)
      switch (c.localName) {
        case 'moveTo':
        case 'lnTo':
          if (pts[0]) cmds.push({ op: c.localName === 'moveTo' ? 'M' : 'L', x: pts[0][0], y: pts[0][1] })
          break
        case 'arcTo':
          cmds.push({ op: 'A', wR: attr(c, 'wR') ?? '0', hR: attr(c, 'hR') ?? '0', stAng: attr(c, 'stAng') ?? '0', swAng: attr(c, 'swAng') ?? '0' })
          break
        case 'quadBezTo':
          if (pts.length >= 2) cmds.push({ op: 'Q', x1: pts[0]![0], y1: pts[0]![1], x: pts[1]![0], y: pts[1]![1] })
          break
        case 'cubicBezTo':
          if (pts.length >= 3) cmds.push({ op: 'C', x1: pts[0]![0], y1: pts[0]![1], x2: pts[1]![0], y2: pts[1]![1], x: pts[2]![0], y: pts[2]![1] })
          break
        case 'close':
          cmds.push({ op: 'Z' })
          break
      }
    }
    const w = Number(attr(p, 'w') ?? 0)
    const h = Number(attr(p, 'h') ?? 0)
    paths.push({ w: w > 0 ? w : null, h: h > 0 ? h : null, fill: FILLS.has(fill) ? fill : 'norm', stroke: attr(p, 'stroke') !== '0' && attr(p, 'stroke') !== 'false', cmds })
  }
  return { av: {}, gd, rect, paths }
}
