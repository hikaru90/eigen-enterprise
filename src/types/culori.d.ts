// Minimal ambient declaration: culori v4 ships untyped JS sources.
// Only the color-conversion surface used by the brand style-format is declared;
// extend it (never loosen it) if more of the library gets consumed.
declare module 'culori' {
  export type Oklch = {
    mode: 'oklch'
    l: number
    c: number
    h: number
    alpha?: number
  }

  export type Color = Oklch | { mode: string; [key: string]: unknown } | string

  /**
   * Generic parsed/converted color components. Conversion can drop channels
   * (e.g. achromatic hues) and parse can fail, so every component is optional
   * — callers narrow before arithmetic.
   */
  export type ColorComponents = {
    mode: string
    l?: number
    c?: number
    h?: number
    a?: number
    b?: number
    r?: number
    g?: number
    alpha?: number
    [key: string]: unknown
  }

  export function wcagContrast(color1: Color, color2: Color): number

  export function wcagLuminance(color: Color): number

  export function oklch(color: Color): Oklch | undefined

  export function formatRgb(color: Color): string | undefined

  export function parse(value: string): ColorComponents | undefined

  export function converter(mode: string): (color: Color) => ColorComponents | undefined
}
