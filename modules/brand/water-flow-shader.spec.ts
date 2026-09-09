import { describe, expect, it } from 'vitest'
import {
  WATER_FLOW_FRAGMENT_SHADER,
  WATER_FLOW_VERTEX_SHADER,
  parseMonochromeTint,
  resolveWaterFlowColors,
} from './water-flow-shader'

describe('parseMonochromeTint', () => {
  it('parses 6-digit hex into normalized sRGB floats', () => {
    expect(parseMonochromeTint('#4a4a4a')).toEqual([0x4a / 255, 0x4a / 255, 0x4a / 255])
    expect(parseMonochromeTint('#ffffff')).toEqual([1, 1, 1])
    expect(parseMonochromeTint('#000000')).toEqual([0, 0, 0])
  })

  it('parses 3-digit hex by digit doubling', () => {
    expect(parseMonochromeTint('#fff')).toEqual([1, 1, 1])
    expect(parseMonochromeTint('#000')).toEqual([0, 0, 0])
    expect(parseMonochromeTint('#888')).toEqual([0x88 / 255, 0x88 / 255, 0x88 / 255])
  })

  it('accepts uppercase hex and surrounding whitespace', () => {
    expect(parseMonochromeTint(' #ABABAB ')).toEqual([0xab / 255, 0xab / 255, 0xab / 255])
  })

  it('rejects non-hex tints loudly (no silent fallback)', () => {
    for (const bad of ['red', 'rgb(10,10,10)', '#12345', '#1234567', '', '#12g12g', 'ababab']) {
      expect(() => parseMonochromeTint(bad), `input: ${JSON.stringify(bad)}`).toThrow(/hex/)
    }
  })

  it('rejects non-monochrome tints (brand rule: grayscale only)', () => {
    expect(() => parseMonochromeTint('#22e876')).toThrow(/monochrome/i)
    expect(() => parseMonochromeTint('#123')).toThrow(/monochrome/i)
  })
})

describe('resolveWaterFlowColors', () => {
  it('parses both endpoints', () => {
    const colors = resolveWaterFlowColors('#060606', '#b9b9b9')
    expect(colors.from).toEqual([0x06 / 255, 0x06 / 255, 0x06 / 255])
    expect(colors.to).toEqual([0xb9 / 255, 0xb9 / 255, 0xb9 / 255])
  })

  it('propagates parse failures with the offending input', () => {
    expect(() => resolveWaterFlowColors('#060606', 'silver')).toThrow(/silver/)
  })
})

describe('shader sources', () => {
  it('fragment shader declares every uniform the component feeds', () => {
    for (const uniform of ['u_resolution', 'u_time', 'u_from', 'u_to', 'u_scale']) {
      expect(WATER_FLOW_FRAGMENT_SHADER).toContain(uniform)
    }
  })

  it('targets WebGL1 (GLSL ES 1.0) with highp fragment precision (free at the fixed tiny resolution, drift-proof over long runtimes)', () => {
    expect(WATER_FLOW_FRAGMENT_SHADER).toMatch(/precision\s+highp\s+float/)
    expect(WATER_FLOW_FRAGMENT_SHADER).not.toContain('#version')
    expect(WATER_FLOW_VERTEX_SHADER).not.toContain('#version')
  })

  it('travels bottom to top: the field is sampled below over time so features rise', () => {
    expect(WATER_FLOW_FRAGMENT_SHADER).toMatch(/-\s*vec2\(0\.0,\s*t\s*\*/)
  })

  it('is a single texture-free pass (no samplers, no texture fetches)', () => {
    expect(WATER_FLOW_FRAGMENT_SHADER).not.toContain('sampler')
    expect(WATER_FLOW_FRAGMENT_SHADER).not.toContain('texture')
  })

  it('animates via domain-warped fbm (three or more fbm evaluations)', () => {
    expect(WATER_FLOW_FRAGMENT_SHADER.match(/fbm\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  it('vertex shader consumes a bare fullscreen-triangle attribute', () => {
    expect(WATER_FLOW_VERTEX_SHADER).toContain('a_position')
    expect(WATER_FLOW_VERTEX_SHADER).toContain('gl_Position')
  })
})
