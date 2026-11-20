/**
 * Find in a PDF and naming pages. A page's searchable text is its text items
 * joined in content order (a line end counts as a space), so a phrase is
 * found across items and lines; matches map back to the items — the spans
 * of the text layer — to be highlighted.
 */

export type PageText = {
  text: string
  /** Where each text item starts in `text` (the text layer has one span per item). */
  starts: number[]
  lengths: number[]
}

export function pageText(items: Array<{ str: string; hasEOL: boolean }>): PageText {
  let text = ''
  const starts: number[] = []
  const lengths: number[] = []
  for (const item of items) {
    starts.push(text.length)
    lengths.push(item.str.length)
    text += item.str
    if (item.hasEOL) text += ' '
  }
  return { text, starts, lengths }
}

/** Lower case, one character for one (so offsets in the folded text are offsets in the original). */
function fold(s: string): string {
  let out = ''
  for (const ch of s) {
    const lower = ch.toLowerCase()
    out += lower.length === ch.length ? lower : ch
  }
  return out
}

export type TextMatch = { start: number; end: number }

/** Every match of `query` on the page, ignoring case. A blank query finds nothing. */
export function findInPage(page: PageText, query: string): TextMatch[] {
  if (query.trim().length === 0) return []
  const hay = fold(page.text)
  const needle = fold(query)
  const out: TextMatch[] = []
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
    out.push({ start: at, end: at + needle.length })
  }
  return out
}

/** The part of each text item that [start, end) covers. */
export function itemRanges(
  page: PageText,
  start: number,
  end: number,
): Array<{ item: number; from: number; to: number }> {
  const out: Array<{ item: number; from: number; to: number }> = []
  page.starts.forEach((s, item) => {
    const e = s + page.lengths[item]!
    const from = Math.max(start, s)
    const to = Math.min(end, e)
    if (from < to) out.push({ item, from: from - s, to: to - s })
  })
  return out
}

/** How the file names page `index` (0-based): its label (/PageLabels), else its number. */
export function pageName(labels: string[] | null, index: number): string {
  return labels?.[index] || String(index + 1)
}

/** The page someone typed: a page label first, then a page number; null when there is no such page. */
export function resolvePageInput(
  input: string,
  labels: string[] | null,
  count: number,
): number | null {
  const typed = input.trim()
  if (!typed) return null
  const byLabel = labels?.indexOf(typed) ?? -1
  if (byLabel !== -1) return byLabel
  if (!/^\d+$/.test(typed)) return null
  const n = Number(typed)
  return n >= 1 && n <= count ? n - 1 : null
}
