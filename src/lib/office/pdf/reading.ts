/**
 * A page's text in reading order, from pdf.js text items. The order is the
 * content's own (how the file paints its text, which is how producers write
 * reading order); geometry only decides where lines and paragraphs break:
 * - a new line when the baseline moves (more than half the text height)
 *   or the item ends a line (`hasEOL`);
 * - a new paragraph when the gap to the next baseline is clearly wider than
 *   the page's line spacing, or the text jumps back up (a new column/box).
 * Shared by the agent text (./text.ts) and the viewer's find (./find.ts).
 */

/** The fields of a pdf.js TextItem this needs (TextMarkedContent entries are skipped by the caller). */
export type PdfTextItem = { str: string; transform: number[]; width: number; hasEOL: boolean }

type Placed = { item: PdfTextItem; x: number; y: number; h: number; angle: number }

export type ReadingLine = { text: string; y: number; h: number; angle: number }

function place(item: PdfTextItem): Placed {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform
  const angle = Math.atan2(b, a)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  // Position in the text's own frame: x along the baseline, y across it (up).
  return { item, x: e * cos + f * sin, y: -e * sin + f * cos, h: Math.hypot(c, d) || 1, angle }
}

const isSpace = (s: string) => s.length > 0 && s.trim().length === 0

/** Items grouped into lines, in content order. */
export function readingLines(items: PdfTextItem[]): ReadingLine[] {
  const lines: ReadingLine[] = []
  let text = ''
  let prev: Placed | null = null
  let lineY = 0
  let lineH = 0
  let lineAngle = 0
  const flush = () => {
    const t = text.replace(/\s+/g, ' ').trim()
    if (t) lines.push({ text: t, y: lineY, h: lineH, angle: lineAngle })
    text = ''
    prev = null
  }
  for (const item of items) {
    if (item.str.length === 0) {
      if (item.hasEOL) flush()
      continue
    }
    const p = place(item)
    if (prev) {
      const sameLine =
        Math.abs(p.angle - lineAngle) < 0.01 && Math.abs(p.y - lineY) <= Math.max(lineH, p.h) / 2
      if (!sameLine) flush()
    }
    if (!prev) {
      lineY = p.y
      lineH = p.h
      lineAngle = p.angle
    } else {
      const gap = p.x - (prev.x + prev.item.width)
      if (gap > 0.15 * Math.max(p.h, prev.h) && !isSpace(prev.item.str) && !isSpace(item.str))
        text += ' '
      lineH = Math.max(lineH, p.h)
    }
    text += item.str
    prev = p
    if (item.hasEOL) flush()
  }
  flush()
  return lines
}

/** Lines joined into paragraphs (lines of one paragraph joined with a space). */
export function readingParagraphs(items: PdfTextItem[]): string[] {
  const lines = readingLines(items)
  if (lines.length === 0) return []
  // The page's line spacing: the tightest ordinary gap, capped at 1.5× the text height
  // so a page whose lines all sit far apart still breaks between them.
  let base = Infinity
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1]!.y - lines[i]!.y
    const h = Math.max(lines[i - 1]!.h, lines[i]!.h)
    if (gap >= 0.9 * h) base = Math.min(base, gap, 1.5 * h)
  }
  const paragraphs: string[] = []
  let current = lines[0]!.text
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!
    const b = lines[i]!
    const gap = a.y - b.y
    const h = Math.max(a.h, b.h)
    const spacing = Number.isFinite(base) ? base : 1.5 * h
    const breaks = Math.abs(a.angle - b.angle) >= 0.01 || gap < 0 || gap > 1.4 * spacing
    if (breaks) {
      paragraphs.push(current)
      current = b.text
    } else {
      current += ' ' + b.text
    }
  }
  paragraphs.push(current)
  return paragraphs
}
