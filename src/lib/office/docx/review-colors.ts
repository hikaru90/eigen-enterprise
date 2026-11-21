/**
 * Each reviewer's colour for tracked changes and comments, as Word does it
 * (one colour per author, the same everywhere). The colour comes from the
 * author's name by a stable hash, so both layouts and every reload agree.
 */
const PALETTE = ['#1d4ed8', '#b91c1c', '#047857', '#7c3aed', '#c2410c', '#0e7490', '#be185d', '#4d7c0f']

export function authorColor(author: string | null | undefined): string {
  const name = author ?? ''
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]!
}
