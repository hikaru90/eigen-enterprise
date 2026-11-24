import { cubicOut } from 'svelte/easing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { motionDuration, panelSlide, prefersReducedMotion } from './panel-slide'

function makeNode(rectWidth = 224, offsetWidth = rectWidth): HTMLElement {
  return {
    offsetWidth,
    getBoundingClientRect: () => ({ width: rectWidth }) as DOMRect,
  } as unknown as HTMLElement
}

describe('panel-slide', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('detects prefers-reduced-motion safely with and without window.matchMedia', () => {
    expect(prefersReducedMotion()).toBe(false)
    expect(motionDuration(200)).toBe(200)

    vi.stubGlobal('window', {})
    expect(prefersReducedMotion()).toBe(false)
    expect(motionDuration(200)).toBe(200)

    vi.stubGlobal('window', {
      matchMedia: vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)' ? false : false,
      })),
    })
    expect(prefersReducedMotion()).toBe(false)
    expect(motionDuration(160)).toBe(160)

    vi.stubGlobal('window', {
      matchMedia: vi.fn((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
      })),
    })
    expect(prefersReducedMotion()).toBe(true)
    expect(motionDuration(200)).toBe(0)
  })

  it('returns 0ms duration when reduced motion is preferred or transition is disabled', () => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: true })),
    })
    expect(panelSlide(makeNode(), { side: 'left', width: 224, duration: 200 })).toEqual({
      duration: 0,
    })

    vi.stubGlobal('window', {
      matchMedia: vi.fn(() => ({ matches: false })),
    })
    expect(
      panelSlide(makeNode(), { side: 'left', width: 224, duration: 200, disabled: true }),
    ).toEqual({ duration: 0 })
  })

  it('returns 0ms duration when the element is hidden (display: none)', () => {
    vi.stubGlobal('getComputedStyle', vi.fn(() => ({ display: 'none' })))
    expect(panelSlide(makeNode(), { side: 'left', width: 224, duration: 200 })).toEqual({
      duration: 0,
    })
  })

  it('animates docked left panel width, translateX, and opacity without negative zero', () => {
    const cfg = panelSlide(makeNode(), { side: 'left', width: 224, duration: 200 })
    expect(cfg.duration).toBe(200)
    expect(cfg.easing).toBe(cubicOut)

    const atStart = cfg.css!(0, 1)
    expect(atStart).toContain('width: 0.00px;')
    expect(atStart).toContain('min-width: 0;')
    expect(atStart).toContain('overflow: hidden;')
    expect(atStart).toContain('transform: translateX(-24.00px);')
    expect(atStart).toContain('opacity: 0.000;')

    const atMid = cfg.css!(0.5, 0.5)
    expect(atMid).toContain('width: 112.00px;')
    expect(atMid).toContain('transform: translateX(-12.00px);')
    expect(atMid).toContain('opacity: 0.500;')

    const atEnd = cfg.css!(1, 0)
    expect(atEnd).toContain('width: 224.00px;')
    expect(atEnd).toContain('transform: translateX(0.00px);')
    expect(atEnd).toContain('opacity: 1.000;')
    expect(atEnd).not.toContain('-0.00px')
  })

  it('animates docked right panel from positive horizontal offset', () => {
    const cfg = panelSlide(makeNode(420), { side: 'right', width: 420 })
    expect(cfg.duration).toBe(200)
    expect(cfg.easing).toBe(cubicOut)

    expect(cfg.css!(0, 1)).toContain('width: 0.00px;')
    expect(cfg.css!(0, 1)).toContain('transform: translateX(24.00px);')
    expect(cfg.css!(1, 0)).toContain('width: 420.00px;')
    expect(cfg.css!(1, 0)).toContain('transform: translateX(0.00px);')
  })

  it('animates fly mode with percentage translateX and opacity without width', () => {
    const rightFly = panelSlide(makeNode(), { side: 'right', mode: 'fly', duration: 200 })
    expect(rightFly.duration).toBe(200)
    expect(rightFly.easing).toBe(cubicOut)

    const startRight = rightFly.css!(0, 1)
    expect(startRight).toContain('transform: translateX(100.00%);')
    expect(startRight).toContain('opacity: 0.000;')
    expect(startRight).not.toContain('width:')

    const endRight = rightFly.css!(1, 0)
    expect(endRight).toContain('transform: translateX(0.00%);')
    expect(endRight).toContain('opacity: 1.000;')

    const leftFly = panelSlide(makeNode(), { side: 'left', mode: 'fly' })
    expect(leftFly.css!(0, 1)).toContain('transform: translateX(-100.00%);')
    expect(leftFly.css!(1, 0)).toContain('transform: translateX(0.00%);')
  })

  it('falls back to measured element width when width is omitted', () => {
    const fromRect = panelSlide(makeNode(360, 0), { side: 'right' })
    expect(fromRect.css!(1, 0)).toContain('width: 360.00px;')

    const fromOffset = panelSlide(makeNode(0, 310), { side: 'left' })
    expect(fromOffset.css!(1, 0)).toContain('width: 310.00px;')
  })
})
