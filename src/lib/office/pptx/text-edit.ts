import type { Paragraph } from './model'
import type { ParagraphEdit, RunEdit, TextPos } from './ops'

/**
 * Typing into a slide's text in place: the text box ./render.ts draws
 * (`<p data-p>` paragraphs, `<span data-r>` runs, `<br data-r>` breaks) is
 * made contenteditable, and what the person typed is read back here as
 * paragraph edits (./ops.ts `setText`) — each piece of text keeps the run it
 * was typed into (its formatting), new paragraphs keep the paragraph they
 * were split from. Positions are characters per paragraph (a line break
 * counts one), which survive the commit and redraw.
 */

/** A place in the edited text: paragraph (in order) and character offset in it. */
export type CharPos = { p: number; c: number }

const BLOCK = new Set(['P', 'DIV'])

type Leaf = { node: Node; kind: 'text' | 'break'; from: { p: number; r: number } | null }
type Block = { el: HTMLElement | null; from: number | null; leaves: Leaf[] }

const dataInt = (el: Element | null, name: string): number | null => {
  const v = el?.getAttribute(name)
  return v === null || v === undefined || v === '' ? null : Number(v)
}

/** The paragraphs of an edited text box and the text pieces in each, in document order. */
function blocks(root: HTMLElement): Block[] {
  const out: Block[] = []
  let cur: Block | null = null
  const open = (from: number | null, el: HTMLElement | null = null) => {
    cur = { el, from: from ?? out.at(-1)?.from ?? null, leaves: [] }
    out.push(cur)
    return cur
  }
  const visit = (node: Node, para: number | null, run: number | null) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.nodeValue) return
      const b: Block = cur ?? open(para)
      b.leaves.push({ node, kind: 'text', from: para !== null && run !== null ? { p: para, r: run } : null })
      return
    }
    if (!(node instanceof HTMLElement)) return
    if (node.classList.contains('pptx-bullet')) return
    if (node.tagName === 'BR') {
      const b: Block = cur ?? open(para)
      const r = dataInt(node, 'data-r')
      b.leaves.push({ node, kind: 'break', from: para !== null && r !== null ? { p: para, r } : null })
      return
    }
    if (BLOCK.has(node.tagName) && node !== root) {
      const p = dataInt(node, 'data-p') ?? para
      open(p, node)
      for (let c = node.firstChild; c; c = c.nextSibling) visit(c, p, null)
      cur = null
      return
    }
    const r = dataInt(node, 'data-r') ?? run
    for (let c = node.firstChild; c; c = c.nextSibling) visit(c, para, r)
  }
  for (let c = root.firstChild; c; c = c.nextSibling) visit(c, null, null)
  // An empty block's lone <br> (no data-r) only holds the line open: not a break.
  for (const b of out) {
    const last = b.leaves.at(-1)
    if (last?.kind === 'break' && last.from === null) b.leaves.pop()
  }
  return out.length ? out : [{ el: null, from: 0, leaves: [] }]
}

/** The text container inside a drawn text box (the element made contenteditable). */
export function textContainer(textBox: Element): HTMLElement | null {
  const inner = textBox.firstElementChild
  return inner instanceof HTMLElement ? inner : null
}

/** What the person typed, as `setText` paragraphs. */
export function readParagraphs(root: HTMLElement): ParagraphEdit[] {
  return blocks(root).map((b) => {
    const runs: RunEdit[] = []
    for (const leaf of b.leaves) {
      if (leaf.kind === 'break') {
        runs.push({ kind: 'break', from: leaf.from })
        continue
      }
      // Pasted or typed newlines inside a text node are line breaks.
      leaf.node.nodeValue!.split('\n').forEach((piece, i) => {
        if (i > 0) runs.push({ kind: 'break', from: leaf.from })
        if (!piece) return
        const prev = runs.at(-1)
        if (prev?.kind === 'text' && prev.from?.p === leaf.from?.p && prev.from?.r === leaf.from?.r) prev.text += piece
        else runs.push({ kind: 'text', text: piece, from: leaf.from })
      })
    }
    return { from: b.from, runs }
  })
}

const leafLength = (l: Leaf) => (l.kind === 'break' ? 1 : l.node.nodeValue!.length)

/** The character position of a DOM point inside the edited text. */
export function charPosOf(root: HTMLElement, node: Node, offset: number): CharPos {
  const bs = blocks(root)
  const point = root.ownerDocument.createRange()
  point.setStart(node, offset)
  const pi = bs.findIndex((b) => b.el && (b.el === node || b.el.contains(node)))
  if (pi < 0) {
    // Between paragraphs: the start of the next one, else the end of the text.
    const next = bs.findIndex((b) => {
      const first = b.el ?? b.leaves[0]?.node
      return first ? point.comparePoint(first, 0) > 0 : false
    })
    if (next >= 0) return { p: next, c: 0 }
    const last = bs.length - 1
    return { p: last, c: bs[last]!.leaves.reduce((n, l) => n + leafLength(l), 0) }
  }
  let c = 0
  for (const leaf of bs[pi]!.leaves) {
    if (leaf.node === node && leaf.kind === 'text') return { p: pi, c: c + offset }
    if (point.comparePoint(leaf.node, 0) > 0) return { p: pi, c }
    c += leafLength(leaf)
  }
  return { p: pi, c }
}

/** The current selection inside `root`, ordered; null when the selection is elsewhere. */
export function selectionIn(root: HTMLElement): { start: CharPos; end: CharPos } | null {
  const sel = root.ownerDocument.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null
  return { start: charPosOf(root, r.startContainer, r.startOffset), end: charPosOf(root, r.endContainer, r.endOffset) }
}

function domPoint(root: HTMLElement, pos: CharPos): [Node, number] {
  const bs = blocks(root)
  const b = bs[Math.max(0, Math.min(pos.p, bs.length - 1))]!
  const indexIn = (n: Node) => Array.prototype.indexOf.call(n.parentNode!.childNodes, n) as number
  let c = pos.c
  for (const leaf of b.leaves) {
    const len = leafLength(leaf)
    if (leaf.kind === 'text' && c <= len) return [leaf.node, c]
    if (leaf.kind === 'break' && c === 0) return [leaf.node.parentNode!, indexIn(leaf.node)]
    c -= len
  }
  const last = b.leaves.at(-1)
  if (last?.kind === 'text') return [last.node, last.node.nodeValue!.length]
  if (last) return [last.node.parentNode!, indexIn(last.node) + 1]
  return [b.el ?? root, 0]
}

/** Selects from `start` to `end` (character positions) inside `root`. */
export function selectChars(root: HTMLElement, start: CharPos, end: CharPos) {
  const sel = root.ownerDocument.getSelection()
  if (!sel) return
  const r = root.ownerDocument.createRange()
  r.setStart(...domPoint(root, start))
  r.setEnd(...domPoint(root, end))
  sel.removeAllRanges()
  sel.addRange(r)
}

/**
 * A character position as a run position in the model's paragraph (what
 * `formatRuns` takes). `slideNumber` is what a slide-number field shows.
 */
export function runPosOf(paragraphs: Paragraph[], pos: CharPos, slideNumber: number): TextPos {
  const p = Math.max(0, Math.min(pos.p, paragraphs.length - 1))
  const runs = paragraphs[p]?.runs ?? []
  let c = pos.c
  for (const [r, run] of runs.entries()) {
    const len = run.kind === 'break' ? 1 : run.kind === 'field' && run.type === 'slidenum' ? String(slideNumber).length : run.text.length
    if (c < len || (c === len && r === runs.length - 1)) return { p, r, o: c }
    c -= len
  }
  return { p, r: Math.max(0, runs.length - 1), o: runs.length ? (runs.at(-1)!.kind === 'break' ? 1 : (runs.at(-1) as { text: string }).text.length) : 0 }
}
