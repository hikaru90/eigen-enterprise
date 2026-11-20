import type { DocxDocument, Section } from './model'
import { flowItems, formatPageNumber, headerFooterFor, type FlowItem } from './flow'
import { layoutAllTabs, PX_PER_PT, renderBlockPlaceholder, renderFlow, renderParagraph, renderTable, type RenderEnv } from './render'

/**
 * Paginated layout (browser only): pages at their true size with margins,
 * headers and footers; block content flows across pages by measuring the
 * rendered heights. A paragraph that doesn't fit is split at a line
 * boundary (respecting w:keepLines and widow/orphan control), a table at a
 * row boundary (header rows repeat), and w:keepNext pulls a paragraph onto
 * the next page with what follows it. Footnotes go at the bottom of the
 * page that references them; endnotes after the last section.
 */

export type LayoutEnv = Omit<RenderEnv, 'pageField'>

export type PaginateOptions = {
  signal?: AbortSignal
  /** Called as pages are added (for a progress line). */
  onPage?: (count: number) => void
  /** How long to work before letting the browser paint (ms). */
  budgetMs?: number
}

export type LaidOutPage = { el: HTMLElement; number: string; widthPt: number; heightPt: number }

type Piece = { el: HTMLElement; item: FlowItem; tableFrom?: number; moved?: boolean }

type Page = {
  frame: HTMLElement
  el: HTMLElement
  flow: HTMLElement
  notes: HTMLElement
  limitPx: number
  pieces: Piece[]
  section: Section
  sectionIndex: number
  number: number
}

export class LayoutAborted extends Error {
  constructor() {
    super('Layout stopped.')
    this.name = 'LayoutAborted'
  }
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

type LineStart = { top: number; bottom: number; node: Node; offset: number }

/** The lines of a rendered paragraph (client coordinates), with the DOM position each starts at. */
export function lineStarts(el: HTMLElement): LineStart[] {
  const lines: LineStart[] = []
  const range = el.ownerDocument.createRange()
  let cur: LineStart | null = null
  const consider = (rect: DOMRect | undefined, node: Node, offset: number) => {
    if (!rect || (rect.width === 0 && rect.height === 0)) return
    const center = (rect.top + rect.bottom) / 2
    if (!cur || center >= cur.bottom) {
      cur = { top: rect.top, bottom: rect.bottom, node, offset }
      lines.push(cur)
    } else {
      cur.top = Math.min(cur.top, rect.top)
      cur.bottom = Math.max(cur.bottom, rect.bottom)
    }
  }
  const walk = (n: Node) => {
    for (let c = n.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === TEXT_NODE) {
        const text = c.textContent ?? ''
        if (!text) continue
        range.selectNodeContents(c)
        const rects = range.getClientRects()
        if (rects.length <= 1) {
          consider(rects[0], c, 0)
          continue
        }
        for (let i = 0; i < text.length; i++) {
          const code = text.charCodeAt(i)
          if (code >= 0xdc00 && code <= 0xdfff) continue
          range.setStart(c, i)
          range.setEnd(c, Math.min(text.length, code >= 0xd800 && code <= 0xdbff ? i + 2 : i + 1))
          consider(range.getClientRects()[0], c, i)
        }
      } else if (c.nodeType === ELEMENT_NODE) {
        const e = c as HTMLElement
        if (e.tagName === 'BR') continue
        if (e.tagName === 'IMG' || e.classList.contains('docx-atom')) consider(e.getBoundingClientRect(), e, -1)
        else walk(e)
      }
    }
  }
  walk(el)
  return lines
}

export async function paginate(doc: DocxDocument, host: HTMLElement, env: LayoutEnv, opts: PaginateOptions = {}): Promise<LaidOutPage[]> {
  const document = env.document
  const budget = opts.budgetMs ?? 40
  let clock = performance.now()
  const breathe = async () => {
    if (opts.signal?.aborted) throw new LayoutAborted()
    if (performance.now() - clock < budget) return
    await new Promise((r) => setTimeout(r, 0))
    if (opts.signal?.aborted) throw new LayoutAborted()
    clock = performance.now()
  }

  const pages: Page[] = []
  const placedNotes = new Set<string>()
  const footnotes = new Map(doc.footnotes.map((n) => [`footnote:${n.id}`, n]))
  let page: Page | null = null
  let sectionPage = 0
  let nextNumber = 1

  const pageEnv = (section: Section, number: number): RenderEnv => ({
    ...env,
    pageField: (code) => (code === 'PAGE' ? formatPageNumber(number, section.props.pageNumbers.format) : code === 'NUMPAGES' || code === 'SECTIONPAGES' ? '' : null),
  })

  function newPage(section: Section, sectionIndex: number): Page {
    const s = section.props
    const number = nextNumber++
    const frame = document.createElement('div')
    frame.className = 'docx-page-frame'
    frame.style.cssText = `position:relative;flex:none;margin-inline:auto;width:calc(${s.pageWidthPt}pt * var(--docx-scale, 1));height:calc(${s.pageHeightPt}pt * var(--docx-scale, 1))`
    const el = document.createElement('div')
    el.className = 'docx-page'
    el.dataset.testid = 'docx-page'
    el.setAttribute('role', 'region')
    el.setAttribute('aria-label', `Page ${pages.length + 1}`)
    el.style.cssText = `position:absolute;top:0;left:0;width:${s.pageWidthPt}pt;height:${s.pageHeightPt}pt;transform:scale(var(--docx-scale, 1));transform-origin:0 0;background:#fff;color:#000;overflow:hidden;font:10pt/1.15 "Times New Roman", serif;text-align:start;letter-spacing:normal;text-transform:none;white-space:normal;box-shadow:0 1px 3px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06)`
    frame.append(el)
    host.append(frame)
    const m = s.margin
    const left = m.leftPt + m.gutterPt
    const penv = pageEnv(section, number)
    const { header, footer } = headerFooterFor(section, sectionPage, number, doc.settings)
    let headerPt = 0
    let footerPt = 0
    if (header) {
      const h = document.createElement('div')
      h.className = 'docx-header'
      h.dataset.testid = 'docx-header'
      h.style.cssText = `position:absolute;top:${m.headerPt}pt;left:${left}pt;right:${m.rightPt}pt`
      h.append(renderFlow(doc.headerFooters.get(header) ?? [], penv))
      el.append(h)
      layoutAllTabs(h, doc.settings.defaultTabStopPt)
      headerPt = h.offsetHeight / PX_PER_PT
    }
    if (footer) {
      const f = document.createElement('div')
      f.className = 'docx-footer'
      f.dataset.testid = 'docx-footer'
      f.style.cssText = `position:absolute;bottom:${m.footerPt}pt;left:${left}pt;right:${m.rightPt}pt`
      f.append(renderFlow(doc.headerFooters.get(footer) ?? [], penv))
      el.append(f)
      layoutAllTabs(f, doc.settings.defaultTabStopPt)
      footerPt = f.offsetHeight / PX_PER_PT
    }
    // A header taller than the top margin pushes the body down (a negative margin means it may not).
    const top = m.topPt < 0 ? -m.topPt : Math.max(m.topPt, header ? m.headerPt + headerPt : 0)
    const bottom = m.bottomPt < 0 ? -m.bottomPt : Math.max(m.bottomPt, footer ? m.footerPt + footerPt : 0)
    const heightPt = Math.max(36, s.pageHeightPt - top - bottom)
    const body = document.createElement('div')
    body.className = 'docx-body'
    body.style.cssText = `position:absolute;top:${top}pt;left:${left}pt;right:${m.rightPt}pt;height:${heightPt}pt`
    const flow = document.createElement('div')
    flow.className = 'docx-flow docx-body-flow'
    flow.style.cssText = 'position:relative;display:flex;flex-direction:column;align-items:stretch'
    const notes = document.createElement('div')
    notes.className = 'docx-notes'
    notes.style.cssText = 'position:absolute;left:0;right:0;bottom:0'
    body.append(flow, notes)
    el.append(body)
    if (sectionPage === 0 && s.columns.count > 1) {
      el.append(pageNote(`This section has ${s.columns.count} columns; shown as one column.`))
    }
    const p: Page = { frame, el, flow, notes, limitPx: heightPt * PX_PER_PT, pieces: [], section, sectionIndex, number }
    pages.push(p)
    sectionPage++
    opts.onPage?.(pages.length)
    return p
  }

  function pageNote(text: string): HTMLElement {
    const n = document.createElement('div')
    n.className = 'docx-page-note'
    n.dataset.testid = 'docx-page-note'
    n.style.cssText =
      'position:absolute;top:6pt;right:6pt;font:8pt/1.3 system-ui, sans-serif;color:#374151;background:#f3f4f6;border:1px solid #d1d5db;border-radius:4pt;padding:2pt 5pt;user-select:none'
    n.textContent = text
    return n
  }

  const notesHeight = (p: Page) => p.notes.offsetHeight

  function fits(p: Page): boolean {
    const last = p.flow.lastElementChild as HTMLElement | null
    if (!last) return true
    return last.offsetTop + last.offsetHeight <= p.limitPx - notesHeight(p) + 0.5
  }

  /** Footnotes referenced in `el` and not yet placed: added at the page bottom; returns what was added. */
  function addNotes(p: Page, el: HTMLElement, penv: RenderEnv): HTMLElement[] {
    const added: HTMLElement[] = []
    for (const ref of el.querySelectorAll<HTMLElement>('[data-note]')) {
      const key = ref.dataset.note!
      const note = footnotes.get(key)
      if (!note || placedNotes.has(key)) continue
      if (p.notes.childElementCount === 0) {
        const sep = document.createElement('div')
        sep.className = 'docx-note-separator'
        sep.style.cssText = 'width:144pt;border-top:0.75pt solid #000;margin:6pt 0 3pt'
        p.notes.append(sep)
        added.push(sep)
      }
      const n = renderFlow(note.blocks, penv)
      n.dataset.noteFor = key
      p.notes.append(n)
      layoutAllTabs(n, doc.settings.defaultTabStopPt)
      placedNotes.add(key)
      added.push(n)
    }
    return added
  }

  function removeNotes(added: HTMLElement[]) {
    for (const a of added) {
      if (a.dataset.noteFor) placedNotes.delete(a.dataset.noteFor)
      a.remove()
    }
  }

  /** The page holds nothing but what was carried over to it (keepNext): moving again would loop. */
  const isEmpty = (p: Page) => p.pieces.every((x) => x.moved)

  function render(item: FlowItem, penv: RenderEnv, from = 0): HTMLElement {
    if (item.kind === 'paragraph') {
      return renderParagraph(item.para, penv, { inlines: item.inlines, first: item.first, last: item.last, prev: item.prev, next: item.next })
    }
    if (item.kind === 'table') {
      const t = renderTable(item.table, penv, from)
      t.style.alignSelf = 'flex-start'
      return t
    }
    return renderBlockPlaceholder(item.block, penv)
  }

  type Split = { kind: 'split'; rest: Piece } | { kind: 'none' } | { kind: 'fits' }

  function splitParagraph(p: Page, piece: Piece): Split {
    const el = piece.el
    if (el.dataset.keepLines && !isEmpty(p)) return { kind: 'none' }
    const lines = lineStarts(el)
    if (lines.length <= 1) return { kind: 'none' }
    const scale = p.el.getBoundingClientRect().width / (p.el.offsetWidth || 1) || 1
    const flowTop = p.flow.getBoundingClientRect().top
    const limit = p.limitPx - notesHeight(p)
    let k = 0
    while (k < lines.length && (lines[k]!.bottom - flowTop) / scale <= limit + 0.5) k++
    if (k >= lines.length) return { kind: 'fits' }
    if (el.dataset.widow) {
      // Widow/orphan control: never one line alone at the bottom or the top of a page.
      if (k === 1) k = 0
      else if (lines.length - k === 1 && k > 1) k--
    }
    if (k === 0) return { kind: 'none' }
    const start = lines[k]!
    const range = el.ownerDocument.createRange()
    if (start.offset >= 0) range.setStart(start.node, start.offset)
    else range.setStartBefore(start.node)
    range.setEnd(el, el.childNodes.length)
    const frag = range.extractContents()
    const rest = el.cloneNode(false) as HTMLElement
    rest.append(frag)
    el.style.marginBottom = '0'
    el.style.borderBottom = 'none'
    if (el.style.textAlign === 'justify') el.style.textAlignLast = 'justify'
    rest.style.marginTop = '0'
    rest.style.textIndent = '0'
    rest.style.borderTop = 'none'
    rest.removeAttribute('role')
    rest.removeAttribute('aria-level')
    return { kind: 'split', rest: { el: rest, item: piece.item } }
  }

  function splitTable(p: Page, piece: Piece, penv: RenderEnv): Split {
    if (piece.item.kind !== 'table') return { kind: 'none' }
    const table = piece.el
    const limit = p.limitPx - notesHeight(p)
    const rows = [...table.querySelectorAll<HTMLElement>(':scope > tbody > tr')].filter((r) => !r.dataset.repeated)
    let firstOut = -1
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i]!
      if (table.offsetTop + tr.offsetTop + tr.offsetHeight > limit + 0.5) {
        firstOut = i
        break
      }
    }
    if (firstOut === -1) return { kind: 'fits' }
    if (firstOut === 0) return { kind: 'none' }
    const from = piece.tableFrom ?? 0
    const splitRow = Number(rows[firstOut]!.dataset.row)
    const t = piece.item.table
    const kept = renderTable(t, penv, from, splitRow)
    kept.style.alignSelf = 'flex-start'
    table.replaceWith(kept)
    piece.el = kept
    layoutAllTabs(kept, doc.settings.defaultTabStopPt)
    return { kind: 'split', rest: { el: render(piece.item, penv, splitRow), item: piece.item, tableFrom: splitRow } }
  }

  /** Trailing pieces that must stay with what follows (w:keepNext), taken off the page if something stays behind. */
  function takeKeepNextTail(p: Page): Piece[] {
    const taken: Piece[] = []
    for (let i = p.pieces.length - 1; i > 0; i--) {
      const pc = p.pieces[i]!
      if (!pc.item.keepNext || pc.el.dataset.continued) break
      taken.unshift(pc)
    }
    if (taken.length === p.pieces.length) return []
    for (const t of taken) {
      t.el.remove()
      p.pieces.splice(p.pieces.indexOf(t), 1)
    }
    return taken
  }

  async function place(item: FlowItem, sectionIndex: number) {
    const section = doc.sections[sectionIndex]!
    if (!page || (item.breakBefore && page.pieces.length > 0)) page = newPage(section, sectionIndex)
    let penv = pageEnv(section, page.number)
    let piece: Piece = { el: render(item, penv), item }
    for (let guard = 0; guard < 10_000; guard++) {
      const p: Page = page!
      p.flow.append(piece.el)
      layoutAllTabs(piece.el, doc.settings.defaultTabStopPt)
      const notes = addNotes(p, piece.el, penv)
      if (fits(p)) {
        p.pieces.push(piece)
        return
      }
      removeNotes(notes)
      const split = item.kind === 'table' ? splitTable(p, piece, penv) : item.kind === 'paragraph' ? splitParagraph(p, piece) : ({ kind: 'none' } as Split)
      if (split.kind === 'fits' || (split.kind === 'none' && isEmpty(p))) {
        // Taller than a whole page (or only its padding spills over): it stays, clipped by the page.
        p.pieces.push(piece)
        addNotes(p, piece.el, penv)
        return
      }
      if (split.kind === 'none') {
        piece.el.remove()
        const carried = takeKeepNextTail(p)
        page = newPage(section, sectionIndex)
        penv = pageEnv(section, page.number)
        for (const c of carried) {
          c.moved = true
          page.flow.append(c.el)
          page.pieces.push(c)
          addNotes(page, c.el, penv)
        }
        if (item.kind === 'table') piece = { el: render(item, penv, piece.tableFrom ?? 0), item, tableFrom: piece.tableFrom }
        await breathe()
        continue
      }
      p.pieces.push(piece)
      addNotes(p, piece.el, penv)
      page = newPage(section, sectionIndex)
      penv = pageEnv(section, page.number)
      split.rest.el.dataset.continued = '1'
      piece = split.rest
      await breathe()
    }
  }

  for (let si = 0; si < doc.sections.length; si++) {
    const section = doc.sections[si]!
    const s = section.props
    const prev: Page | null = page
    const sameSize = prev && prev.section.props.pageWidthPt === s.pageWidthPt && prev.section.props.pageHeightPt === s.pageHeightPt
    const continuous = si > 0 && s.start === 'continuous' && sameSize
    if (s.pageNumbers.start !== undefined && !continuous) nextNumber = s.pageNumbers.start
    if (!continuous) {
      sectionPage = 0
      // Even/odd section starts leave a blank page when the parity is wrong.
      if (si > 0 && ((s.start === 'evenPage' && nextNumber % 2 === 1) || (s.start === 'oddPage' && nextNumber % 2 === 0))) newPage(section, si)
      page = newPage(section, si)
    } else if (prev) {
      prev.section = section
      prev.sectionIndex = si
      sectionPage = 1
    }
    for (const item of flowItems(section.blocks)) {
      await place(item, si)
      await breathe()
    }
  }
  if (doc.endnotes.length > 0) {
    const si = doc.sections.length - 1
    const sep = document.createElement('div')
    sep.className = 'docx-note-separator'
    sep.style.cssText = 'width:144pt;border-top:0.75pt solid #000;margin:12pt 0 6pt'
    page!.flow.append(sep)
    for (const n of doc.endnotes) for (const item of flowItems(n.blocks)) await place(item, si)
  }

  // Page fields now that every page exists: PAGE per page, NUMPAGES and SECTIONPAGES in total.
  const perSection = new Map<number, number>()
  for (const p of pages) perSection.set(p.sectionIndex, (perSection.get(p.sectionIndex) ?? 0) + 1)
  for (const p of pages) {
    const fmt = p.section.props.pageNumbers.format
    for (const f of p.el.querySelectorAll<HTMLElement>('[data-field]')) {
      const code = f.dataset.field
      if (code === 'PAGE') f.textContent = formatPageNumber(p.number, fmt)
      else if (code === 'NUMPAGES') f.textContent = String(pages.length)
      else if (code === 'SECTIONPAGES') f.textContent = String(perSection.get(p.sectionIndex) ?? 0)
    }
  }
  return pages.map((p) => ({ el: p.el, number: formatPageNumber(p.number, p.section.props.pageNumbers.format), widthPt: p.section.props.pageWidthPt, heightPt: p.section.props.pageHeightPt }))
}
