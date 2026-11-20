import { describe, expect, it } from 'vitest'
import { buildGeometry, evalFormula, guideValues, type GeomDef } from './geometry'
import { PRESETS, presetGeometry } from './presets'

const near = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps

/** Every number in a path string, in order. */
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?(e-?\d+)?/g) ?? []).map(Number)

describe('shape guide formulas (ECMA-376 §20.1.9.11)', () => {
  const vars = new Map([
    ['w', 200],
    ['h', 100],
    ['x', 30],
  ])
  it('evaluates every operator', () => {
    expect(evalFormula('*/ w 3 4', vars)).toBe(150)
    expect(evalFormula('+- w x 10', vars)).toBe(220)
    expect(evalFormula('+/ w h 3', vars)).toBe(100)
    expect(evalFormula('?: x w h', vars)).toBe(200)
    expect(evalFormula('?: 0 w h', vars)).toBe(100)
    expect(evalFormula('abs -5', vars)).toBe(5)
    expect(evalFormula('at2 1 1', vars)).toBe(2700000)
    expect(near(evalFormula('cat2 10 1 1', vars), 10 * Math.SQRT1_2)).toBe(true)
    expect(near(evalFormula('sat2 10 1 1', vars), 10 * Math.SQRT1_2)).toBe(true)
    expect(near(evalFormula('cos 10 5400000', vars), 0)).toBe(true)
    expect(near(evalFormula('sin 10 5400000', vars), 10)).toBe(true)
    expect(near(evalFormula('tan 10 2700000', vars), 10)).toBe(true)
    expect(evalFormula('max w h', vars)).toBe(200)
    expect(evalFormula('min w h', vars)).toBe(100)
    expect(evalFormula('mod 3 4 0', vars)).toBe(5)
    expect(evalFormula('pin 0 x 20', vars)).toBe(20)
    expect(evalFormula('pin 0 -4 20', vars)).toBe(0)
    expect(evalFormula('sqrt 81', vars)).toBe(9)
    expect(evalFormula('val 42', vars)).toBe(42)
  })

  it('fails loud on an unknown operator or name', () => {
    expect(() => evalFormula('foo 1 2', vars)).toThrow(/foo/)
    expect(() => evalFormula('*/ nope 1 1', vars)).toThrow(/nope/)
  })

  it('built-ins, adjust defaults, overrides and guides evaluate in order', () => {
    const def: GeomDef = { av: { adj: 10000 }, gd: [['x1', '*/ ss adj 100000'], ['x2', '+- r 0 x1']], rect: null, paths: [] }
    const v = guideValues(def, 400, 200, {})
    expect([v.get('ss'), v.get('hc'), v.get('wd4'), v.get('cd4'), v.get('x1'), v.get('x2')]).toEqual([200, 200, 100, 5400000, 20, 380])
    const o = guideValues(def, 400, 200, { adj: 'val 50000' })
    expect(o.get('x1')).toBe(100)
  })
})

describe('preset geometry', () => {
  it('rect is the frame', () => {
    const g = buildGeometry(presetGeometry('rect')!, 100, 50, {})
    expect(g.paths[0]!.d).toBe('M0 0L100 0L100 50L0 50Z')
    expect(g.textRect).toEqual({ l: 0, t: 0, r: 100, b: 50 })
  })

  it('roundRect has corner arcs of radius adj × short side', () => {
    const g = buildGeometry(presetGeometry('roundRect')!, 200, 100, { adj: 'val 20000' })
    const d = g.paths[0]!.d
    expect(d.startsWith('M0 20A20 20 0 0 1 20 0L180 0A20 20 0 0 1 200 20')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
  })

  it('ellipse is a closed full arc (split in two halves for SVG)', () => {
    const g = buildGeometry(presetGeometry('ellipse')!, 100, 60, {})
    const d = g.paths[0]!.d
    expect(d).toMatch(/^M0 30A50 30 0 \d 1 100 30A50 30 0 \d 1 0 30Z$/)
    // inscribed text rectangle at 45°
    expect(near(g.textRect.l, 50 - 50 * Math.SQRT1_2)).toBe(true)
    expect(near(g.textRect.t, 30 - 30 * Math.SQRT1_2)).toBe(true)
  })

  it('arcTo on an ellipse uses the visual angle (a quarter of a 2:1 ellipse lands on the axis)', () => {
    const def: GeomDef = {
      av: {},
      gd: [],
      rect: null,
      paths: [{ w: null, h: null, fill: 'norm', stroke: true, cmds: [{ op: 'M', x: 'r', y: 'vc' }, { op: 'A', wR: 'wd2', hR: 'hd2', stAng: '0', swAng: '2700000' }] }],
    }
    const g = buildGeometry(def, 200, 100, {})
    const [, , , , , , , ex, ey] = numbers(g.paths[0]!.d)
    // Visual 45° on a 100×50 radius ellipse: the point where the 45° ray meets it.
    const t = Math.atan2(100 * Math.sin(Math.PI / 4), 50 * Math.cos(Math.PI / 4))
    expect(near(ex!, 100 + 100 * Math.cos(t))).toBe(true)
    expect(near(ey!, 50 + 50 * Math.sin(t))).toBe(true)
  })

  it('triangle apex follows adj; rightArrow head length follows adj2', () => {
    const tri = buildGeometry(presetGeometry('triangle')!, 100, 80, { adj: 'val 0' })
    expect(tri.paths[0]!.d).toBe('M0 80L0 0L100 80Z')
    const arrow = buildGeometry(presetGeometry('rightArrow')!, 300, 100, {})
    // shaft half height 25 around vc=50, head starts at r - 50 (adj2 50% of ss=100)
    expect(arrow.paths[0]!.d).toBe('M0 25L250 25L250 0L300 50L250 100L250 75L0 75Z')
  })

  it('star5 points and the regular pentagon fit the frame', () => {
    const star = numbers(buildGeometry(presetGeometry('star5')!, 100, 100, {}).paths[0]!.d)
    const xs = star.filter((_, i) => i % 2 === 0)
    const ys = star.filter((_, i) => i % 2 === 1)
    expect(near(Math.min(...ys), 0, 0.5)).toBe(true)
    expect(near(Math.max(...ys), 100, 0.5)).toBe(true)
    expect(near(Math.min(...xs), 0, 0.5)).toBe(true)
    expect(near(Math.max(...xs), 100, 0.5)).toBe(true)
    expect(xs).toHaveLength(10)
    const pent = numbers(buildGeometry(presetGeometry('pentagon')!, 100, 100, {}).paths[0]!.d)
    expect(near(Math.max(...pent.filter((_, i) => i % 2 === 1)), 100, 0.5)).toBe(true)
  })

  it('connectors are stroked, not filled', () => {
    const line = buildGeometry(presetGeometry('line')!, 10, 20, {})
    expect(line.paths[0]).toMatchObject({ d: 'M0 0L10 20', fill: 'none', stroke: true })
    const bent = buildGeometry(presetGeometry('bentConnector3')!, 100, 40, {})
    expect(bent.paths[0]!.d).toBe('M0 0L50 0L50 40L100 40')
  })

  it('wedgeRectCallout puts its tail on the edge facing the tip', () => {
    const below = buildGeometry(presetGeometry('wedgeRectCallout')!, 120, 60, {})
    // default tip: 20.833% of the width left of centre, 62.5% of the height below it → under the box
    expect(below.paths[0]!.d).toContain('L35 67.5L')
    const right = buildGeometry(presetGeometry('wedgeRectCallout')!, 120, 60, { adj1: 'val 80000', adj2: 'val 0' })
    expect(right.paths[0]!.d).toContain('L156 30L')
  })

  it('a path with its own coordinate space scales to the shape', () => {
    const g = buildGeometry(presetGeometry('flowChartTerminator')!, 216, 108, {})
    expect(g.paths[0]!.d.startsWith('M34.75 0L181.25 0A34.75 54')).toBe(true)
  })

  it('has the presets the plan lists', () => {
    for (const name of ['rect', 'roundRect', 'ellipse', 'triangle', 'rtTriangle', 'diamond', 'parallelogram', 'trapezoid', 'pentagon', 'hexagon', 'octagon', 'star5', 'rightArrow', 'leftArrow', 'upArrow', 'downArrow', 'chevron', 'homePlate', 'line', 'straightConnector1', 'bentConnector3', 'wedgeRectCallout']) {
      expect(PRESETS[name], name).toBeDefined()
      const g = buildGeometry(presetGeometry(name)!, 300, 200, {})
      expect(g.paths.length, name).toBeGreaterThan(0)
      for (const p of g.paths) expect(p.d, name).not.toMatch(/NaN|Infinity/)
    }
    expect(presetGeometry('cloudyThing')).toBeNull()
  })
})
