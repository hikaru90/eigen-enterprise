import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import WaterFlow from './water-flow.svelte'

describe('water-flow.svelte', () => {
  // vitest-browser-svelte does not auto-cleanup — stacked components leak canvases.
  const mounted: Array<() => void> = []

  afterEach(() => {
    for (const unmount of mounted.reverse()) unmount()
    mounted.length = 0
    vi.restoreAllMocks()
  })

  it('mounts a decorative canvas with the host context applied', () => {
    const { container } = render(WaterFlow, { class: 'hero-canvas' })
    const canvas = container.querySelector('canvas[data-water-flow]')
    expect(canvas).not.toBeNull()
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
    expect(canvas?.classList.contains('hero-canvas')).toBe(true)
  })

  it('renders the static tint fallback and logs loud when WebGL is unavailable', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const { container } = render(WaterFlow, {})
    expect(container.querySelector('canvas[data-water-flow="static"]')).not.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('degrades to the static tint when a tint is not monochrome (brand rule)', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(WaterFlow, { from: '#22e876' })
    expect(container.querySelector('canvas[data-water-flow="static"]')).not.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('keeps the canvas interactive-free and positioned as a background layer', () => {
    const { container } = render(WaterFlow, {})
    const canvas = container.querySelector('canvas')
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')
    expect(canvas?.getAttribute('data-water-flow')).toBeDefined()
  })

  it('renders at the fixed internal resolution when one is provided', () => {
    const { container } = render(WaterFlow, { resolution: { width: 60, height: 9 } })
    const canvas = container.querySelector(
      'canvas[data-water-flow="webgl"]',
    ) as HTMLCanvasElement | null
    expect(canvas).not.toBeNull()
    expect(canvas?.width).toBe(60)
    expect(canvas?.height).toBe(9)
  })

  it('grids the canvas into rounded cells aligned to the fixed resolution', () => {
    const { container } = render(WaterFlow, { resolution: { width: 60, height: 9 } })
    const canvas = container.querySelector('canvas') as HTMLCanvasElement | null
    expect(canvas?.classList.contains('cells')).toBe(true)
    expect(canvas?.classList.contains('pixelated')).toBe(true)
    expect(canvas?.style.getPropertyValue('--cells-x')).toBe('60')
    expect(canvas?.style.getPropertyValue('--cells-y')).toBe('9')
  })

  it('decouples the pill grid from the canvas resolution (smooth gradients inside pills)', () => {
    const { container } = render(WaterFlow, {
      resolution: { width: 160, height: 64 },
      cells: { x: 40, y: 8 },
    })
    const canvas = container.querySelector('canvas') as HTMLCanvasElement | null
    expect(canvas?.width).toBe(160)
    expect(canvas?.height).toBe(64)
    expect(canvas?.classList.contains('cells')).toBe(true)
    expect(canvas?.classList.contains('pixelated')).toBe(false)
    expect(canvas?.style.getPropertyValue('--cells-x')).toBe('40')
    expect(canvas?.style.getPropertyValue('--cells-y')).toBe('8')
  })

  it('rejects non-integer or non-positive cell grids loudly into the static fallback', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(WaterFlow, { cells: { x: 40, y: 0 } })
    expect(container.querySelector('canvas[data-water-flow="static"]')).not.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('stays unmasked when no fixed resolution is set', () => {
    const { container } = render(WaterFlow, {})
    const canvas = container.querySelector('canvas') as HTMLCanvasElement | null
    expect(canvas?.classList.contains('cells')).toBe(false)
  })

  it('rejects non-integer or non-positive resolutions loudly into the static fallback', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(WaterFlow, { resolution: { width: 60.5, height: 9 } })
    expect(container.querySelector('canvas[data-water-flow="static"]')).not.toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })
})
