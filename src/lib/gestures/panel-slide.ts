import type { TransitionConfig } from 'svelte/transition'
import { cubicOut } from 'svelte/easing'

export type PanelSlideParams = {
  side: 'left' | 'right'
  width?: number
  duration?: number
  disabled?: boolean
  mode?: 'dock' | 'fly'
}

/** True when the browser/OS requests reduced motion. Safe during SSR and headless stubs. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Returns 0 when reduced motion is active, otherwise `ms`. */
export function motionDuration(ms: number): number {
  return prefersReducedMotion() ? 0 : ms
}

const SLIDE_PX = 24

/**
 * Svelte transition for horizontal sidebars/panels.
 * - `'dock'` (default): animates width (`0 <-> width`), subtle horizontal slide (`translateX`), and opacity.
 * - `'fly'`: slides `translateX(±100% <-> 0%)` and opacity without touching width (for overlaid mobile sheets).
 * Respects `(prefers-reduced-motion: reduce)`, `disabled`, and `display: none`.
 */
export function panelSlide(node: Element, params: PanelSlideParams): TransitionConfig {
  if (params.disabled || prefersReducedMotion()) return { duration: 0 }
  if (typeof getComputedStyle === 'function' && getComputedStyle(node).display === 'none') {
    return { duration: 0 }
  }

  const duration = params.duration ?? 200
  const sign = params.side === 'left' ? -1 : 1

  if (params.mode === 'fly') {
    return {
      duration,
      easing: cubicOut,
      css: (t, u) => {
        const tx = u === 0 ? 0 : sign * u * 100
        return `transform: translateX(${tx.toFixed(2)}%); opacity: ${t.toFixed(3)};`
      },
    }
  }

  const el = node as HTMLElement
  const rectWidth =
    typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect().width : 0
  const targetWidth =
    params.width && params.width > 0 ? params.width : rectWidth || el.offsetWidth || 0

  return {
    duration,
    easing: cubicOut,
    css: (t, u) => {
      const w = t * targetWidth
      const tx = u === 0 ? 0 : sign * u * SLIDE_PX
      return `width: ${w.toFixed(2)}px; min-width: 0; overflow: hidden; transform: translateX(${tx.toFixed(2)}px); opacity: ${t.toFixed(3)};`
    },
  }
}
