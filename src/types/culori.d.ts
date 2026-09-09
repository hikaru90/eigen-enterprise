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

  export function wcagContrast(color1: Color, color2: Color): number

  export function wcagLuminance(color: Color): number

  export function oklch(color: Color): Oklch | undefined

  export function formatRgb(color: Color): string | undefined
}
