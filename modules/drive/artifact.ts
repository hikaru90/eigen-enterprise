/**
 * Artifacts (plan/phase-artifacts.md): HTML files in Drive that agents create
 * and edit and people see rendered — a page (`<name>.html`) or a slide deck
 * (`<name>.deck.html`). Which one a file is, is its file name (a format fact,
 * like every Drive preview), never its content's meaning. A deck is an HTML
 * document we lay out: each slide is a 1920×1080 stage between markers, so
 * one slide can be replaced, inserted, moved or deleted without touching the
 * rest; it scales to the frame it is shown in and prints one slide per page.
 * Pure functions only — the tools (./artifact-tools.ts) do the Drive I/O.
 */

export const ARTIFACT_KINDS = ['page', 'deck'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const DECK_SUFFIX = '.deck.html'
/** Slides of one deck (a long deck goes into several). */
export const DECK_MAX_SLIDES = 200

const DECK_OPEN = '<!--ee-deck-->'
const DECK_CLOSE = '<!--/ee-deck-->'
const SLIDE_OPEN = '<!--ee-slide-->'
const SLIDE_CLOSE = '<!--/ee-slide-->'
const SLIDE_RE = /<!--ee-slide-->([\s\S]*?)<!--\/ee-slide-->/g

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactError'
  }
}

/** The kind of artifact a file is by its name, else null (not an HTML file). */
export function artifactKindOf(name: string): ArtifactKind | null {
  const lower = name.toLowerCase()
  if (lower.endsWith(DECK_SUFFIX)) return 'deck'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'page'
  return null
}

/** The Drive file name for a new artifact: "Pitch" → "Pitch.deck.html" / "Pitch.html". */
export function artifactFileName(kind: ArtifactKind, rawName: string): string {
  const base = rawName.trim()
  if (!base) throw new ArtifactError('An artifact needs a name.')
  if (artifactKindOf(base) === kind) return base
  const stem = base.replace(/\.(deck\.)?html?$/i, '')
  return kind === 'deck' ? `${stem}${DECK_SUFFIX}` : `${stem}.html`
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function checkSlide(html: string, index: number): string {
  if (html.includes('<!--ee-slide') || html.includes('<!--/ee-slide') || html.includes('<!--ee-deck') || html.includes('<!--/ee-deck'))
    throw new ArtifactError(`Slide ${index + 1} contains a deck marker comment (<!--ee-…-->); remove it.`)
  return html
}

const wrapSlide = (inner: string) => `<div class="ee-frame"><section class="ee-slide">${SLIDE_OPEN}${inner}${SLIDE_CLOSE}</section></div>`

/**
 * The deck's own layout: 1920×1080 stages scaled to the frame's width (a
 * tiny inline script sets --ee-scale), and in print one stage per page at
 * full size (the PDF export).
 */
const DECK_BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;background:#1c1c1e}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.ee-deck{display:flex;flex-direction:column;gap:16px;padding:16px}
.ee-frame{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.4)}
.ee-slide{position:absolute;top:0;left:0;width:1920px;height:1080px;transform-origin:0 0;transform:scale(var(--ee-scale,0.25));background:#fff;color:#111;overflow:hidden}
@page{size:1920px 1080px;margin:0}
@media print{html,body{background:none}.ee-deck{display:block;padding:0}.ee-frame{width:1920px;height:1080px;aspect-ratio:auto;border-radius:0;box-shadow:none;break-after:page}.ee-slide{transform:none}}
`

const DECK_SCRIPT = `(function(){function f(){var e=document.querySelector('.ee-frame');if(e)document.documentElement.style.setProperty('--ee-scale',String(e.clientWidth/1920))}addEventListener('resize',f);f()})()`

export type DeckParts = { title: string; css?: string; slides: string[] }

/** A new deck document from its slides (each slide's inner HTML on a 1920×1080 stage). */
export function deckDocument(parts: DeckParts): string {
  if (parts.slides.length > DECK_MAX_SLIDES) throw new ArtifactError(`A deck can have at most ${DECK_MAX_SLIDES} slides.`)
  const slides = parts.slides.map((s, i) => wrapSlide(checkSlide(s, i)))
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="ee-artifact" content="deck">',
    `<title>${escapeHtml(parts.title)}</title>`,
    `<style>${DECK_BASE_CSS}</style>`,
    `<style>${parts.css ?? ''}</style>`,
    '</head>',
    '<body>',
    `<main class="ee-deck">${DECK_OPEN}`,
    slides.join('\n'),
    `${DECK_CLOSE}</main>`,
    `<script>${DECK_SCRIPT}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

type ParsedDeck = { before: string; slides: string[]; after: string }

function parseDeck(html: string): ParsedDeck {
  const start = html.indexOf(DECK_OPEN)
  const end = html.indexOf(DECK_CLOSE)
  if (start < 0 || end < start)
    throw new ArtifactError('This deck has lost its slide markers (<!--ee-deck-->), so its slides cannot be edited one by one; rewrite it whole (content).')
  const middle = html.slice(start + DECK_OPEN.length, end)
  return {
    before: html.slice(0, start + DECK_OPEN.length),
    slides: [...middle.matchAll(SLIDE_RE)].map((m) => m[1]!),
    after: html.slice(end),
  }
}

/** A deck's slides (each one's inner HTML, in order). */
export function deckSlides(html: string): string[] {
  return parseDeck(html).slides
}

export type SlideOp =
  | { op: 'replace'; index: number; html: string }
  | { op: 'insert'; index: number; html: string }
  | { op: 'delete'; index: number }
  | { op: 'move'; from: number; to: number }

/** Applies slide operations in order (indexes 0-based, each against the deck as the previous op left it). */
export function applySlideOps(html: string, ops: SlideOp[]): string {
  const deck = parseDeck(html)
  const slides = [...deck.slides]
  const at = (i: number, n: number, what: string) => {
    if (!Number.isInteger(i) || i < 0 || i >= n) throw new ArtifactError(`${what} ${i} does not exist; the deck has ${slides.length} slides (0–${slides.length - 1}).`)
  }
  for (const op of ops) {
    if (op.op === 'replace') {
      at(op.index, slides.length, 'Slide')
      slides[op.index] = checkSlide(op.html, op.index)
    } else if (op.op === 'insert') {
      at(op.index, slides.length + 1, 'Insert position')
      slides.splice(op.index, 0, checkSlide(op.html, op.index))
    } else if (op.op === 'delete') {
      at(op.index, slides.length, 'Slide')
      slides.splice(op.index, 1)
    } else {
      at(op.from, slides.length, 'Slide')
      at(op.to, slides.length, 'Move target')
      const [s] = slides.splice(op.from, 1)
      slides.splice(op.to, 0, s!)
    }
  }
  if (slides.length > DECK_MAX_SLIDES) throw new ArtifactError(`A deck can have at most ${DECK_MAX_SLIDES} slides.`)
  return `${deck.before}\n${slides.map(wrapSlide).join('\n')}\n${deck.after}`
}

export type TextEdit = { find: string; replace: string }

/** Exact find/replace edits, in order; each `find` must occur exactly once (else nothing changes). */
export function applyTextEdits(content: string, edits: TextEdit[]): string {
  let out = content
  edits.forEach((e, i) => {
    if (!e.find) throw new ArtifactError(`Edit ${i + 1}: find is empty.`)
    const first = out.indexOf(e.find)
    if (first < 0) throw new ArtifactError(`Edit ${i + 1}: the text to find does not occur; read the artifact again (artifacts.read) and copy it exactly.`)
    if (out.indexOf(e.find, first + 1) >= 0) throw new ArtifactError(`Edit ${i + 1}: the text to find occurs more than once; include more surrounding text so it is unique.`)
    out = out.slice(0, first) + e.replace + out.slice(first + e.find.length)
  })
  return out
}
