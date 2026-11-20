import type { GeomDef, GeomPath, PathCmd, PathFill } from './geometry'

/**
 * Preset shapes (ECMA-376 Part 1 §20.1.10.56, ST_ShapeType), written for this
 * reader from what each shape is: its adjust handles and their default values
 * (the format's documented defaults, needed to read files the same way their
 * writer did) and the outline that follows from them. Guide names are ours.
 *
 * A compact notation keeps them readable:
 *   gd   "name = op x y z; …"            (§20.1.9.11 formulas)
 *   d    "M x y L x y A wR hR st sw Q … C … Z"  (moveTo, lnTo, arcTo, quadBezTo, cubicBezTo, close)
 *   rect "l t r b"                        (the text rectangle)
 * A shape not listed here is drawn as a labelled placeholder, never guessed.
 */

type PresetSrc = {
  av?: Record<string, number>
  gd?: string
  rect?: string
  paths: Array<{ d: string; fill?: PathFill; stroke?: boolean; w?: number; h?: number }>
}

function parseD(d: string): PathCmd[] {
  const t = d.trim().split(/\s+/)
  const out: PathCmd[] = []
  let i = 0
  const next = () => {
    const v = t[i++]
    if (v === undefined) throw new Error(`Preset path ends early: ${d}`)
    return v
  }
  while (i < t.length) {
    const op = next()
    if (op === 'M' || op === 'L') out.push({ op, x: next(), y: next() })
    else if (op === 'A') out.push({ op, wR: next(), hR: next(), stAng: next(), swAng: next() })
    else if (op === 'Q') out.push({ op, x1: next(), y1: next(), x: next(), y: next() })
    else if (op === 'C') out.push({ op, x1: next(), y1: next(), x2: next(), y2: next(), x: next(), y: next() })
    else if (op === 'Z') out.push({ op })
    else throw new Error(`Unknown preset path command ${op} in: ${d}`)
  }
  return out
}

function compile(src: PresetSrc): GeomDef {
  const gd: Array<[string, string]> = (src.gd ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const eq = s.indexOf('=')
      return [s.slice(0, eq).trim(), s.slice(eq + 1).trim()] as [string, string]
    })
  const r = src.rect?.trim().split(/\s+/)
  const paths: GeomPath[] = src.paths.map((p) => ({ w: p.w ?? null, h: p.h ?? null, fill: p.fill ?? 'norm', stroke: p.stroke ?? true, cmds: parseD(p.d) }))
  return { av: src.av ?? {}, gd, rect: r && r.length === 4 ? (r as [string, string, string, string]) : null, paths }
}

const RECT = 'M l t L r t L r b L l b Z'
const DIAMOND = 'M l vc L hc t L r vc L hc b Z'
const ELLIPSE: PresetSrc = {
  gd: 'idx = cos wd2 2700000; idy = sin hd2 2700000; il = +- hc 0 idx; ir = +- hc idx 0; it = +- vc 0 idy; ib = +- vc idy 0',
  rect: 'il it ir ib',
  paths: [{ d: 'M l vc A wd2 hd2 cd2 21600000 Z' }],
}
const LINE: PresetSrc = { paths: [{ d: 'M l t L r b', fill: 'none' }] }

/** Regular five-point geometry shared by pentagon and star5: outer points around (hc, svc). */
const FIVE =
  'swd2 = */ wd2 hf 100000; shd2 = */ hd2 vf 100000; svc = */ vc vf 100000; ' +
  'dx1 = cos swd2 1080000; dx2 = cos swd2 18360000; dy1 = sin shd2 1080000; dy2 = sin shd2 18360000; ' +
  'x1 = +- hc 0 dx1; x2 = +- hc 0 dx2; x3 = +- hc dx2 0; x4 = +- hc dx1 0; y1 = +- svc 0 dy1; y2 = +- svc 0 dy2'

const SOURCES: Record<string, PresetSrc> = {
  rect: { paths: [{ d: RECT }] },
  flowChartProcess: { paths: [{ d: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', w: 1, h: 1 }] },
  roundRect: {
    av: { adj: 16667 },
    gd: 'a = pin 0 adj 50000; x1 = */ ss a 100000; x2 = +- r 0 x1; y2 = +- b 0 x1; il = */ x1 29289 100000; ir = +- r 0 il; ib = +- b 0 il',
    rect: 'il il ir ib',
    paths: [{ d: 'M l x1 A x1 x1 cd2 cd4 L x2 t A x1 x1 3cd4 cd4 L r y2 A x1 x1 0 cd4 L x1 b A x1 x1 cd4 cd4 Z' }],
  },
  flowChartAlternateProcess: {
    gd: 'x2 = +- r 0 ssd6; y2 = +- b 0 ssd6; il = */ ssd6 29289 100000; ir = +- r 0 il; ib = +- b 0 il',
    rect: 'il il ir ib',
    paths: [{ d: 'M l ssd6 A ssd6 ssd6 cd2 cd4 L x2 t A ssd6 ssd6 3cd4 cd4 L r y2 A ssd6 ssd6 0 cd4 L ssd6 b A ssd6 ssd6 cd4 cd4 Z' }],
  },
  ellipse: ELLIPSE,
  flowChartConnector: ELLIPSE,
  triangle: {
    av: { adj: 50000 },
    gd: 'a = pin 0 adj 100000; x1 = */ w a 200000; x2 = */ w a 100000; x3 = +- x1 wd2 0',
    rect: 'x1 vc x3 b',
    paths: [{ d: 'M l b L x2 t L r b Z' }],
  },
  rtTriangle: {
    gd: 'it = */ h 7 12; ir = */ w 7 12; ib = */ h 11 12',
    rect: 'l it ir ib',
    paths: [{ d: 'M l b L l t L r b Z' }],
  },
  diamond: { gd: 'ir = */ w 3 4; ib = */ h 3 4', rect: 'wd4 hd4 ir ib', paths: [{ d: DIAMOND }] },
  flowChartDecision: { gd: 'ir = */ w 3 4; ib = */ h 3 4', rect: 'wd4 hd4 ir ib', paths: [{ d: DIAMOND }] },
  parallelogram: {
    av: { adj: 25000 },
    gd: 'maxAdj = */ 100000 w ss; a = pin 0 adj maxAdj; x1 = */ ss a 200000; x2 = */ ss a 100000; x6 = +- r 0 x2; x5 = +- r 0 x1',
    rect: 'x1 t x5 b',
    paths: [{ d: 'M l b L x2 t L r t L x6 b Z' }],
  },
  trapezoid: {
    av: { adj: 25000 },
    gd: 'maxAdj = */ 50000 w ss; a = pin 0 adj maxAdj; x2 = */ ss a 100000; x3 = +- r 0 x2; il = */ wd3 a maxAdj; it = */ hd3 a maxAdj; ir = +- r 0 il',
    rect: 'il it ir b',
    paths: [{ d: 'M l b L x2 t L x3 t L r b Z' }],
  },
  pentagon: {
    av: { hf: 105146, vf: 110557 },
    gd: `${FIVE}; it = */ y1 dx2 dx1`,
    rect: 'x2 it x3 y2',
    paths: [{ d: 'M x1 y1 L hc t L x4 y1 L x3 y2 L x2 y2 Z' }],
  },
  hexagon: {
    av: { adj: 25000, vf: 115470 },
    gd: 'maxAdj = */ 50000 w ss; a = pin 0 adj maxAdj; shd2 = */ hd2 vf 100000; x1 = */ ss a 100000; x2 = +- r 0 x1; dy1 = sin shd2 3600000; y1 = +- vc 0 dy1; y2 = +- vc dy1 0',
    rect: 'x1 y1 x2 y2',
    paths: [{ d: 'M l vc L x1 y1 L x2 y1 L r vc L x2 y2 L x1 y2 Z' }],
  },
  octagon: {
    av: { adj: 29289 },
    gd: 'a = pin 0 adj 50000; x1 = */ ss a 100000; x2 = +- r 0 x1; y2 = +- b 0 x1; il = */ x1 1 2; ir = +- r 0 il; ib = +- b 0 il',
    rect: 'il il ir ib',
    paths: [{ d: 'M l x1 L x1 t L x2 t L r x1 L r y2 L x2 b L x1 b L l y2 Z' }],
  },
  star5: {
    av: { adj: 19098, hf: 105146, vf: 110557 },
    gd:
      `a = pin 0 adj 50000; ${FIVE}; iwd2 = */ swd2 a 50000; ihd2 = */ shd2 a 50000; ` +
      'sdx1 = cos iwd2 1080000; sdx2 = cos iwd2 18360000; sdy1 = sin ihd2 1080000; sdy2 = sin ihd2 18360000; ' +
      'sx1 = +- hc 0 sdx1; sx2 = +- hc 0 sdx2; sx3 = +- hc sdx2 0; sx4 = +- hc sdx1 0; sy1 = +- svc sdy2 0; sy2 = +- svc sdy1 0; sy3 = +- svc ihd2 0',
    rect: 'sx1 sy1 sx4 sy3',
    paths: [{ d: 'M x1 y1 L sx2 sy1 L hc t L sx3 sy1 L x4 y1 L sx4 sy2 L x3 y2 L hc sy3 L x2 y2 L sx1 sy2 Z' }],
  },
  plus: {
    av: { adj: 25000 },
    gd: 'a = pin 0 adj 50000; x1 = */ ss a 100000; x2 = +- r 0 x1; y2 = +- b 0 x1',
    rect: 'l x1 r y2',
    paths: [{ d: 'M l x1 L x1 x1 L x1 t L x2 t L x2 x1 L r x1 L r y2 L x2 y2 L x2 b L x1 b L x1 y2 L l y2 Z' }],
  },
  rightArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 = */ 100000 w ss; a1 = pin 0 adj1 100000; a2 = pin 0 adj2 maxAdj2; dx1 = */ ss a2 100000; x1 = +- r 0 dx1; dy1 = */ h a1 200000; y1 = +- vc 0 dy1; y2 = +- vc dy1 0',
    rect: 'l y1 x1 y2',
    paths: [{ d: 'M l y1 L x1 y1 L x1 t L r vc L x1 b L x1 y2 L l y2 Z' }],
  },
  leftArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 = */ 100000 w ss; a1 = pin 0 adj1 100000; a2 = pin 0 adj2 maxAdj2; x2 = */ ss a2 100000; dy1 = */ h a1 200000; y1 = +- vc 0 dy1; y2 = +- vc dy1 0',
    rect: 'x2 y1 r y2',
    paths: [{ d: 'M l vc L x2 t L x2 y1 L r y1 L r y2 L x2 y2 L x2 b Z' }],
  },
  upArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 = */ 100000 h ss; a1 = pin 0 adj1 100000; a2 = pin 0 adj2 maxAdj2; y2 = */ ss a2 100000; dx1 = */ w a1 200000; x1 = +- hc 0 dx1; x2 = +- hc dx1 0',
    rect: 'x1 y2 x2 b',
    paths: [{ d: 'M l y2 L hc t L r y2 L x2 y2 L x2 b L x1 b L x1 y2 Z' }],
  },
  downArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 = */ 100000 h ss; a1 = pin 0 adj1 100000; a2 = pin 0 adj2 maxAdj2; dy1 = */ ss a2 100000; y1 = +- b 0 dy1; dx1 = */ w a1 200000; x1 = +- hc 0 dx1; x2 = +- hc dx1 0',
    rect: 'x1 t x2 y1',
    paths: [{ d: 'M l y1 L x1 y1 L x1 t L x2 t L x2 y1 L r y1 L hc b Z' }],
  },
  leftRightArrow: {
    av: { adj1: 50000, adj2: 50000 },
    gd: 'maxAdj2 = */ 50000 w ss; a1 = pin 0 adj1 100000; a2 = pin 0 adj2 maxAdj2; x2 = */ ss a2 100000; x3 = +- r 0 x2; dy = */ h a1 200000; y1 = +- vc 0 dy; y2 = +- vc dy 0',
    rect: 'x2 y1 x3 y2',
    paths: [{ d: 'M l vc L x2 t L x2 y1 L x3 y1 L x3 t L r vc L x3 b L x3 y2 L x2 y2 L x2 b Z' }],
  },
  chevron: {
    av: { adj: 50000 },
    gd: 'maxAdj = */ 100000 w ss; a = pin 0 adj maxAdj; x1 = */ ss a 100000; x2 = +- r 0 x1',
    rect: 'x1 t x2 b',
    paths: [{ d: 'M l t L x2 t L r vc L x2 b L l b L x1 vc Z' }],
  },
  homePlate: {
    av: { adj: 50000 },
    gd: 'maxAdj = */ 100000 w ss; a = pin 0 adj maxAdj; dx1 = */ ss a 100000; x1 = +- r 0 dx1',
    rect: 'l t x1 b',
    paths: [{ d: 'M l t L x1 t L r vc L x1 b L l b Z' }],
  },
  snip1Rect: {
    av: { adj: 16667 },
    gd: 'a = pin 0 adj 50000; dx1 = */ ss a 100000; x1 = +- r 0 dx1; it = */ dx1 1 2; ir = +/ x1 r 2',
    rect: 'l it ir b',
    paths: [{ d: 'M l t L x1 t L r dx1 L r b L l b Z' }],
  },
  round2SameRect: {
    av: { adj1: 16667, adj2: 0 },
    gd: 'a1 = pin 0 adj1 50000; a2 = pin 0 adj2 50000; tx1 = */ ss a1 100000; tx2 = +- r 0 tx1; bx1 = */ ss a2 100000; bx2 = +- r 0 bx1; by1 = +- b 0 bx1; il = */ tx1 29289 100000; ir = +- r 0 il',
    rect: 'il il ir by1',
    paths: [{ d: 'M tx1 t L tx2 t A tx1 tx1 3cd4 cd4 L r by1 A bx1 bx1 0 cd4 L bx1 b A bx1 bx1 cd4 cd4 L l tx1 A tx1 tx1 cd2 cd4 Z' }],
  },
  flowChartTerminator: {
    gd: 'rx = */ w 3475 21600; il = */ rx 29289 100000; ir = +- r 0 il; it = */ hd2 29289 100000; ib = +- b 0 it',
    rect: 'il it ir ib',
    paths: [{ d: 'M 3475 0 L 18125 0 A 3475 10800 3cd4 cd2 L 3475 21600 A 3475 10800 cd4 cd2 Z', w: 21600, h: 21600 }],
  },
  donut: {
    av: { adj: 25000 },
    gd: 'a = pin 0 adj 50000; dr = */ ss a 100000; iwd2 = +- wd2 0 dr; ihd2 = +- hd2 0 dr',
    paths: [{ d: 'M l vc A wd2 hd2 cd2 21600000 Z M dr vc A iwd2 ihd2 cd2 -21600000 Z' }],
  },
  frame: {
    av: { adj1: 12500 },
    gd: 'a1 = pin 0 adj1 50000; x1 = */ ss a1 100000; x4 = +- r 0 x1; y4 = +- b 0 x1',
    rect: 'x1 x1 x4 y4',
    paths: [{ d: 'M l t L r t L r b L l b Z M x1 x1 L x1 y4 L x4 y4 L x4 x1 Z' }],
  },
  wedgeRectCallout: {
    av: { adj1: -20833, adj2: 62500 },
    gd:
      // The tail tip, relative to the centre; the tail leaves from the edge facing it.
      'dxPos = */ w adj1 100000; dyPos = */ h adj2 100000; xPos = +- hc dxPos 0; yPos = +- vc dyPos 0; ' +
      'xA = */ w 2 12; xB = */ w 5 12; xC = */ w 7 12; xD = */ w 10 12; yA = */ h 2 12; yB = */ h 5 12; yC = */ h 7 12; yD = */ h 10 12; ' +
      'xb1 = ?: dxPos xC xA; xb2 = ?: dxPos xD xB; yb1 = ?: dyPos yC yA; yb2 = ?: dyPos yD yB; ' +
      // Mostly vertical (|dy| ≥ |dx| in proportion) → top or bottom edge, else left or right.
      'dq = */ dxPos h w; ady = abs dyPos; adq = abs dq; dz = +- ady 0 adq; vert = +- dz 1 0; horiz = +- 0 0 dz; ' +
      'negDy = +- 0 0 dyPos; negDx = +- 0 0 dxPos; ' +
      'onTop = ?: vert negDy -1; onBottom = ?: vert dyPos -1; onLeft = ?: horiz negDx -1; onRight = ?: horiz dxPos -1; ' +
      'tTx = ?: onTop xPos xb1; tTy = ?: onTop yPos t; tBx = ?: onBottom xPos xb2; tBy = ?: onBottom yPos b; ' +
      'tRx = ?: onRight xPos r; tRy = ?: onRight yPos yb1; tLx = ?: onLeft xPos l; tLy = ?: onLeft yPos yb2',
    paths: [
      {
        d:
          'M l t L xb1 t L tTx tTy L xb2 t L r t L r yb1 L tRx tRy L r yb2 L r b L xb2 b L tBx tBy L xb1 b ' +
          'L l b L l yb2 L tLx tLy L l yb1 Z',
      },
    ],
  },
  line: LINE,
  straightConnector1: LINE,
  bentConnector2: { paths: [{ d: 'M l t L r t L r b', fill: 'none' }] },
  bentConnector3: {
    av: { adj1: 50000 },
    gd: 'x1 = */ w adj1 100000',
    paths: [{ d: 'M l t L x1 t L x1 b L r b', fill: 'none' }],
  },
  curvedConnector3: {
    av: { adj1: 50000 },
    gd: 'x2 = */ w adj1 100000; x1 = +/ l x2 2; x3 = +/ r x2 2; y3 = */ h 3 4',
    paths: [{ d: 'M l t C x1 t x2 hd4 x2 vc C x2 y3 x3 b r b', fill: 'none' }],
  },
}

export const PRESETS: Record<string, GeomDef> = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, compile(v)]))

/** The definition of a preset shape, or null when this reader does not draw it yet. */
export function presetGeometry(name: string): GeomDef | null {
  return Object.hasOwn(PRESETS, name) ? PRESETS[name]! : null
}
