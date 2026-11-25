<script lang="ts" module>
  import type { RichRun } from './rich-text'

  export type GridCell = {
    text: string
    align: 'left' | 'center' | 'right'
    /** Inline CSS from the cell's format (font, fill, colour). */
    css: string
    wrap: boolean
    /** Where the text sits in a taller row (Excel's default: bottom). */
    vertical?: 'top' | 'center' | 'bottom'
    /** A formula whose value is Excel's last result (this editor can't calculate it): why. */
    kept: string | null
    /** The number format can't be shown: the plain value is. */
    unreadFormat: boolean
    /** Excel 365 IMAGE-in-cell picture URL and alt text. */
    imageUrl?: string | null
    imageAlt?: string
    /** Cell carries a legacy sticky note (red top-right triangle). */
    hasNote?: boolean
    /** Cell carries a threaded comment (purple top-right indicator). */
    thread?: { count: number; resolved: boolean } | null
    /** Rich-text runs inside the cell (if formatted in substrings). */
    runs?: RichRun[]
  }
  export type Pos = { row: number; col: number }
  export type Move = 'down' | 'up' | 'right' | 'left' | 'none'
</script>

<script lang="ts">
  import type { SheetOutline } from './rows-cols'
  import type { SheetData } from './workbook'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import FunnelIcon from '@lucide/svelte/icons/funnel'
  import { onMount, tick, type Snippet } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { cycleAbsoluteAt, type FormulaRefHighlight } from './formula-edit'
  import { resolveGridKey } from './keyboard'
  import { colName, type Range } from './ref'
  import { runCss } from './rich-text'
  import {
    normalizeRange,
    rangeContains,
    sameRange,
    selectionOf,
    type HeldSelection,
  } from './selection'

  /**
   * The sheet's cells as a grid (only the visible part is drawn): column
   * letters and row numbers, outline grouping gutter, cells with rich text
   * and formats, merged ranges, multi-range Ctrl selection, fill handle drag
   * & double-click autofill, keyboard navigation parity, AutoFilter dropdowns,
   * column/row drag resize & double-click autofit, and point-to-select +
   * coloured formula reference highlights.
   */
  let {
    rows,
    cols,
    colWidth,
    rowHeight,
    cellAt,
    merges,
    rev,
    editable,
    label,
    active = $bindable({ row: 0, col: 0 }),
    anchor = $bindable({ row: 0, col: 0 }),
    extraSelections = $bindable<Range[]>([]),
    held = $bindable<HeldSelection | null>(null),
    editing = $bindable(false),
    draft = $bindable(''),
    data = null,
    editTextOf,
    oncommit,
    onclear,
    onclearranges,
    onpaste,
    copyText,
    oncopyclip,
    oncutclip,
    onpasteclip,
    onfill,
    onfilldblclick,
    onfillshortcut,
    onautofit,
    outline = null,
    onoutline,
    cutRange = null,
    formulaRefs = [],
    pointSelectMode = false,
    onpointselect,
    oneditcursor,
    onselectcommit,
    onfind,
    ongoto,
    showGridlines = true,
    showHeadings = true,
    onreach,
    onblocked,
    frozenRows = 0,
    frozenCols = 0,
    filter = null,
    onfilter,
    onresize,
    overlay,
    oncellselect,
    onnoteopen,
    oncellhover,
  }: {
    rows: number
    cols: number
    colWidth: (c: number) => number
    rowHeight: (r: number) => number
    cellAt: (r: number, c: number) => GridCell | null
    merges: Range[]
    rev: number
    editable: boolean
    label: string
    active?: Pos
    anchor?: Pos
    extraSelections?: Range[]
    /** The selection kept while Tab/Enter move inside it. */
    held?: HeldSelection | null
    editing?: boolean
    draft?: string
    data?: SheetData | null
    editTextOf: (r: number, c: number) => string
    oncommit: (pos: Pos, text: string, move: Move) => void
    onclear: (range: Range) => void
    onclearranges?: (ranges: Range[]) => void
    onpaste: (pos: Pos, text: string) => void
    copyText: (range: Range) => string
    oncopyclip?: (range: Range, event: ClipboardEvent) => void
    oncutclip?: (range: Range, event: ClipboardEvent) => void
    onpasteclip?: (pos: Pos, event: ClipboardEvent) => void
    onfill?: (source: Range, target: Range) => void
    onfilldblclick?: (source: Range) => void
    onfillshortcut?: (dir: 'down' | 'right', range: Range) => void
    onautofit?: (axis: 'col' | 'row', index: number) => void
    outline?: SheetOutline | null
    onoutline?: (act: {
      axis: 'row' | 'col'
      kind: 'toggle' | 'level'
      from?: number
      to?: number
      collapsed?: boolean
      level?: number
    }) => void
    cutRange?: Range | null
    formulaRefs?: FormulaRefHighlight[]
    pointSelectMode?: boolean
    onpointselect?: (range: Range, commit: boolean) => void
    oneditcursor?: (start: number, end: number) => void
    onselectcommit?: (range: Range) => void
    onfind?: (replace: boolean) => void
    ongoto?: () => void
    showGridlines?: boolean
    showHeadings?: boolean
    onreach?: (axis: 'row' | 'col') => void
    onblocked?: () => void
    frozenRows?: number
    frozenCols?: number
    /** The sheet's AutoFilter and its tables' filters: their ranges (drop-downs on each first row), and which columns filter. */
    filter?: { ranges: Range[]; filtered: (row: number, col: number) => boolean } | null
    /** A filter button (or Alt+↓) asked for the menu of column `col` of the filter whose header row is `row`, shown at `at`. */
    onfilter?: (col: number, at: DOMRect, row: number) => void
    /** A column's or row's edge was dragged to a new size (pixels); without it there are no drag handles. */
    onresize?: (axis: 'col' | 'row', index: number, px: number) => void
    /** Floating layer over the main cell pane (`dx`/`dy` are the frozen offsets). */
    overlay?: Snippet<[{ dx: number; dy: number }]>
    /** A cell click moved selection back onto the grid. */
    oncellselect?: () => void
    /** Clicked a cell's note triangle or comment badge. */
    onnoteopen?: (pos: Pos, at: DOMRect) => void
    /** Pointer entered or left an annotated cell (for hover preview). */
    oncellhover?: (pos: Pos | null, at: DOMRect | null) => void
  } = $props()

  const BASE_HEAD_H = 24
  const BASE_HEAD_W = 48
  const OUTLINE_PX = 20
  const OVERSCAN = 4

  const hasRowOutline = $derived(!!outline && outline.rows.length > 0)
  const hasColOutline = $derived(!!outline && outline.cols.length > 0)
  const OUT_W = $derived(hasRowOutline ? OUTLINE_PX : 0)
  const OUT_H = $derived(hasColOutline ? OUTLINE_PX : 0)
  const HEAD_H = $derived(showHeadings ? BASE_HEAD_H : 0)
  const HEAD_W = $derived(showHeadings ? BASE_HEAD_W : 0)
  const TOP_OFF = $derived(HEAD_H + OUT_H)
  const LEFT_OFF = $derived(HEAD_W + OUT_W)

  let scroller = $state<HTMLDivElement | null>(null)
  let cellEditor = $state<HTMLTextAreaElement | null>(null)
  let scrollTop = $state(0)
  let scrollLeft = $state(0)
  let viewW = $state(800)
  let viewH = $state(400)
  let dragging = false
  let endMode = false
  let pointPickAnchor: Pos | null = null

  /** Start offsets of each row/column (plus the end), from the sizes. */
  const rowTops = $derived.by(() => {
    void rev
    const out = new Float64Array(rows + 1)
    for (let r = 0; r < rows; r++) out[r + 1] = out[r]! + rowHeight(r)
    return out
  })
  const colLefts = $derived.by(() => {
    void rev
    const out = new Float64Array(cols + 1)
    for (let c = 0; c < cols; c++) out[c + 1] = out[c]! + colWidth(c)
    return out
  })

  function indexAt(at: Float64Array, x: number): number {
    let lo = 0
    let hi = at.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (at[mid]! <= x) lo = mid
      else hi = mid - 1
    }
    return Math.max(0, lo)
  }

  /** Frozen panes: how many rows/columns, and their height/width. */
  const fr = $derived(Math.max(0, Math.min(frozenRows, rows - 1)))
  const fc = $derived(Math.max(0, Math.min(frozenCols, cols - 1)))
  const FH = $derived(rowTops[fr]!)
  const FW = $derived(colLefts[fc]!)

  const firstRow = $derived(Math.max(fr, indexAt(rowTops, scrollTop + FH) - OVERSCAN))
  const lastRow = $derived(Math.min(rows - 1, indexAt(rowTops, scrollTop + viewH) + OVERSCAN))
  const firstCol = $derived(Math.max(fc, indexAt(colLefts, scrollLeft + FW) - OVERSCAN))
  const lastCol = $derived(Math.min(cols - 1, indexAt(colLefts, scrollLeft + viewW) + OVERSCAN))
  const span = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i)
  const visibleRows = $derived(span(firstRow, lastRow))
  const visibleCols = $derived(span(firstCol, lastCol))
  const frozenRowList = $derived(span(0, fr - 1))
  const frozenColList = $derived(span(0, fc - 1))

  const sel = $derived<Range>(selectionOf(active, anchor, held))
  const allSelections = $derived([...extraSelections, sel])
  const activeQuad = $derived(`${active.row < fr ? 't' : 'b'}${active.col < fc ? 'l' : 'r'}`)
  const fillQuad = $derived(`${sel.bottom < fr ? 't' : 'b'}${sel.right < fc ? 'l' : 'r'}`)

  function mergeAt(r: number, c: number): { range: Range; start: boolean } | null {
    for (const mr of merges)
      if (r >= mr.top && r <= mr.bottom && c >= mr.left && c <= mr.right)
        return { range: mr, start: r === mr.top && c === mr.left }
    return null
  }

  function box(r: Range) {
    const top = rowTops[r.top]!
    const left = colLefts[r.left]!
    return {
      top,
      left,
      width: colLefts[Math.min(r.right + 1, cols)]! - left,
      height: rowTops[Math.min(r.bottom + 1, rows)]! - top,
    }
  }

  const selBox = $derived(box(sel))
  const activeBox = $derived(
    box(
      mergeAt(active.row, active.col)?.range ?? {
        top: active.row,
        bottom: active.row,
        left: active.col,
        right: active.col,
      },
    ),
  )
  const activeId = $derived(`xlsx-cell-${active.row}-${active.col}`)

  onMount(() => {
    if (!scroller) return
    const ro = new ResizeObserver(() => {
      if (!scroller) return
      viewW = scroller.clientWidth
      viewH = scroller.clientHeight
    })
    ro.observe(scroller)
    viewW = scroller.clientWidth || viewW
    viewH = scroller.clientHeight || viewH
    return () => ro.disconnect()
  })

  function onScroll() {
    if (!scroller) return
    scrollTop = scroller.scrollTop
    scrollLeft = scroller.scrollLeft
    if (scrollTop + viewH > rowTops[rows]! - 200) onreach?.('row')
    if (scrollLeft + viewW > colLefts[cols]! - 200) onreach?.('col')
  }

  function reveal() {
    if (!scroller) return
    const b = activeBox
    const bodyH = scroller.clientHeight - TOP_OFF
    const bodyW = scroller.clientWidth - LEFT_OFF
    if (active.row >= fr) {
      if (b.top < scroller.scrollTop + FH) scroller.scrollTop = b.top - FH
      else if (b.top + b.height > scroller.scrollTop + bodyH)
        scroller.scrollTop = b.top + b.height - bodyH
    }
    if (active.col >= fc) {
      if (b.left < scroller.scrollLeft + FW) scroller.scrollLeft = b.left - FW
      else if (b.left + b.width > scroller.scrollLeft + bodyW)
        scroller.scrollLeft = b.left + b.width - bodyW
    }
    onScroll()
  }

  export function focus() {
    scroller?.focus({ preventScroll: true })
  }

  export function revealActive() {
    void tick().then(reveal)
  }

  function moveTo(row: number, col: number, extend = false) {
    const next = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
    active = next
    if (!extend) {
      anchor = next
      extraSelections = []
    }
    void tick().then(reveal)
  }

  async function beginEdit(initial: string | null) {
    if (!editable) {
      onblocked?.()
      return
    }
    const mr = mergeAt(active.row, active.col)
    if (mr && !mr.start) moveTo(mr.range.top, mr.range.left)
    draft = initial ?? editTextOf(active.row, active.col)
    editing = true
    await tick()
    cellEditor?.focus()
    const end = draft.length
    cellEditor?.setSelectionRange(end, end)
    oneditcursor?.(end, end)
  }

  /** Ends editing: the text goes to the page (`commit`) or is dropped. */
  export function finishEdit(commit: boolean, move: Move = 'none', refocus = true) {
    if (!editing) return
    editing = false
    const text = draft
    if (commit) oncommit({ ...active }, text, move)
    if (commit && move !== 'none') {
      const mr = mergeAt(active.row, active.col)?.range
      const r = active.row
      const c = active.col
      if (move === 'down') moveTo((mr ? mr.bottom : r) + 1, c)
      else if (move === 'up') moveTo(r - 1, c)
      else if (move === 'right') moveTo(r, (mr ? mr.right : c) + 1)
      else if (move === 'left') moveTo(r, c - 1)
    }
    if (refocus) focus()
  }

  export function startEdit(initial: string | null = null) {
    void beginEdit(initial)
  }

  function onKeydown(event: KeyboardEvent) {
    if (editing || event.defaultPrevented) return
    const mr = mergeAt(active.row, active.col)?.range ?? null
    const visRows = Math.max(1, Math.floor(viewH / 20) - 2)
    const visCols = Math.max(1, Math.floor(viewW / 64) - 1)
    const action = resolveGridKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      active,
      sel,
      selections: allSelections,
      rows,
      cols,
      visibleRows: visRows,
      visibleCols: visCols,
      data,
      hasFilterAtActive: filterButtonAt(active.row, active.col),
      endMode,
      mergeBottomRight: mr ? { row: mr.bottom, col: mr.right } : null,
    })
    endMode = action.kind === 'end_mode_on'
    if (action.kind === 'none') return
    event.preventDefault()
    switch (action.kind) {
      case 'end_mode_on':
        break
      case 'open_filter':
        openFilter(active.col, document.getElementById(activeId), active.row)
        break
      case 'move':
        moveTo(action.to.row, action.to.col, action.extend)
        break
      case 'move_in_sel':
        held = { range: { ...sel }, active: action.to, anchor: { ...anchor } }
        active = action.to
        void tick().then(reveal)
        break
      case 'select_range':
        extraSelections = []
        anchor = { row: action.range.top, col: action.range.left }
        active = { row: action.range.bottom, col: action.range.right }
        void tick().then(reveal)
        break
      case 'select_cols':
        anchor = { row: 0, col: sel.left }
        active = { row: rows - 1, col: sel.right }
        break
      case 'select_rows':
        anchor = { row: sel.top, col: 0 }
        active = { row: sel.bottom, col: cols - 1 }
        break
      case 'begin_edit':
        void beginEdit(action.initial)
        break
      case 'clear':
        if (!editable) onblocked?.()
        else if (onclearranges) onclearranges(allSelections)
        else onclear(sel)
        break
      case 'cancel':
        extraSelections = []
        anchor = { ...active }
        break
      case 'fill_down':
        if (!editable) onblocked?.()
        else onfillshortcut?.('down', sel)
        break
      case 'fill_right':
        if (!editable) onblocked?.()
        else onfillshortcut?.('right', sel)
        break
      case 'open_find':
        onfind?.(action.replace)
        break
      case 'open_goto':
        ongoto?.()
        break
    }
  }

  function syncEditorCursor() {
    if (!cellEditor) return
    oneditcursor?.(
      cellEditor.selectionStart ?? draft.length,
      cellEditor.selectionEnd ?? draft.length,
    )
  }

  function onEditorKeydown(event: KeyboardEvent) {
    if (event.key === 'F4' && draft.startsWith('=') && cellEditor) {
      event.preventDefault()
      const start = cellEditor.selectionStart ?? draft.length
      const end = cellEditor.selectionEnd ?? draft.length
      const cycled = cycleAbsoluteAt(draft, start, end)
      if (cycled) {
        draft = cycled.text
        void tick().then(() => {
          cellEditor?.setSelectionRange(cycled.selEnd, cycled.selEnd)
          oneditcursor?.(cycled.selEnd, cycled.selEnd)
        })
      }
      return
    }
    if (event.key === 'Enter' && !event.altKey) {
      event.preventDefault()
      finishEdit(true, event.shiftKey ? 'up' : 'down')
    } else if (event.key === 'Tab') {
      event.preventDefault()
      finishEdit(true, event.shiftKey ? 'left' : 'right')
    } else if (event.key === 'Escape') {
      event.preventDefault()
      finishEdit(false)
    }
  }

  function posFromEvent(event: PointerEvent | MouseEvent, clamp = false): Pos | null {
    if (!scroller) return null
    const rect = scroller.getBoundingClientRect()
    const vx = event.clientX - rect.left - LEFT_OFF
    const vy = event.clientY - rect.top - TOP_OFF
    if (!clamp && (vx < 0 || vy < 0)) return null
    const cvx = Math.max(0, vx)
    const cvy = Math.max(0, vy)
    const x = cvx < FW ? cvx : cvx + scroller.scrollLeft
    const y = cvy < FH ? cvy : cvy + scroller.scrollTop
    return {
      row: Math.max(0, Math.min(rows - 1, indexAt(rowTops, y))),
      col: Math.max(0, Math.min(cols - 1, indexAt(colLefts, x))),
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const p = posFromEvent(event)
    if (!p) return
    if (pointSelectMode && onpointselect) {
      event.preventDefault()
      pointPickAnchor = p
      onpointselect(normalizeRange(p, p), false)
      return
    }
    if (editing) finishEdit(true, 'none', false)
    const mr = mergeAt(p.row, p.col)
    const at = mr ? { row: mr.range.top, col: mr.range.left } : p
    const addRange = event.ctrlKey || event.metaKey
    if (event.shiftKey) {
      active = at
    } else if (addRange) {
      extraSelections = [...extraSelections, sel]
      active = at
      anchor = at
    } else {
      extraSelections = []
      active = at
      anchor = at
    }
    dragging = true
    oncellselect?.()
    focus()
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent) {
    if (!(event.buttons & 1)) return
    if (pointPickAnchor && onpointselect) {
      const p = posFromEvent(event, true)
      if (p) onpointselect(normalizeRange(pointPickAnchor, p), false)
      return
    }
    if (!dragging) return
    const p = posFromEvent(event)
    if (p && (p.row !== active.row || p.col !== active.col)) active = p
  }

  function onPointerUp(event: PointerEvent) {
    if (pointPickAnchor && onpointselect) {
      const p = posFromEvent(event, true) ?? pointPickAnchor
      const r = normalizeRange(pointPickAnchor, p)
      pointPickAnchor = null
      onpointselect(r, true)
      return
    }
    if (dragging) {
      dragging = false
      onselectcommit?.(sel)
    }
  }

  function pickColumn(c: number, extend: boolean, addRange: boolean) {
    if (editing) finishEdit(true)
    if (extend) {
      anchor = { row: 0, col: anchor.col }
    } else if (addRange) {
      extraSelections = [...extraSelections, sel]
      anchor = { row: 0, col: c }
    } else {
      extraSelections = []
      anchor = { row: 0, col: c }
    }
    active = { row: rows - 1, col: c }
    focus()
    onselectcommit?.(sel)
  }

  function pickRow(r: number, extend: boolean, addRange: boolean) {
    if (editing) finishEdit(true)
    if (extend) {
      anchor = { row: anchor.row, col: 0 }
    } else if (addRange) {
      extraSelections = [...extraSelections, sel]
      anchor = { row: r, col: 0 }
    } else {
      extraSelections = []
      anchor = { row: r, col: 0 }
    }
    active = { row: r, col: cols - 1 }
    focus()
    onselectcommit?.(sel)
  }

  function onCopy(event: ClipboardEvent) {
    if (editing) return
    if (oncopyclip) {
      oncopyclip(sel, event)
      return
    }
    event.clipboardData?.setData('text/plain', copyText(sel))
    event.preventDefault()
  }

  function onCut(event: ClipboardEvent) {
    if (editing || !oncutclip) return
    if (!editable) {
      event.preventDefault()
      onblocked?.()
      return
    }
    oncutclip(sel, event)
  }

  function onPaste(event: ClipboardEvent) {
    if (editing) return
    event.preventDefault()
    if (!editable) {
      onblocked?.()
      return
    }
    if (onpasteclip) {
      onpasteclip({ row: sel.top, col: sel.left }, event)
      return
    }
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text !== '') onpaste({ row: sel.top, col: sel.left }, text)
  }

  // Fill handle drag (bottom-right of selection)
  type FillDrag = { source: Range; target: Range }
  let fillDrag = $state<FillDrag | null>(null)

  function fillExtend(source: Range, p: Pos): Range {
    const vDist =
      p.row > source.bottom ? p.row - source.bottom : p.row < source.top ? source.top - p.row : 0
    const hDist =
      p.col > source.right ? p.col - source.right : p.col < source.left ? source.left - p.col : 0
    if (vDist === 0 && hDist === 0) return source
    if (vDist >= hDist) {
      return p.row > source.bottom ? { ...source, bottom: p.row } : { ...source, top: p.row }
    }
    return p.col > source.right ? { ...source, right: p.col } : { ...source, left: p.col }
  }

  function onFillHandleDown(event: PointerEvent) {
    if (event.button !== 0 || !editable || !onfill) return
    event.preventDefault()
    event.stopPropagation()
    const source = { ...sel }
    fillDrag = { source, target: source }
    window.addEventListener('pointermove', onFillHandleMove)
    window.addEventListener('pointerup', onFillHandleUp, { once: true })
  }

  function onFillHandleMove(event: PointerEvent) {
    if (!fillDrag) return
    const p = posFromEvent(event, true)
    if (!p) return
    fillDrag = { ...fillDrag, target: fillExtend(fillDrag.source, p) }
  }

  function onFillHandleUp() {
    window.removeEventListener('pointermove', onFillHandleMove)
    const fd = fillDrag
    fillDrag = null
    if (fd && !sameRange(fd.source, fd.target)) {
      anchor = { row: fd.target.top, col: fd.target.left }
      active = { row: fd.target.bottom, col: fd.target.right }
      onfill?.(fd.source, fd.target)
    }
    focus()
  }

  // Dragging a column's right edge or a row's bottom edge
  type Resizing = { axis: 'col' | 'row'; index: number; from: number; base: number; px: number }
  let resizing = $state<Resizing | null>(null)
  const MIN_PX = { col: 8, row: 6 }

  function onHandleDown(event: PointerEvent, axis: 'col' | 'row', index: number) {
    if (event.button !== 0 || !onresize) return
    event.preventDefault()
    event.stopPropagation()
    if (editing) finishEdit(true)
    const base = axis === 'col' ? colWidth(index) : rowHeight(index)
    resizing = { axis, index, from: axis === 'col' ? event.clientX : event.clientY, base, px: base }
    window.addEventListener('pointermove', onHandleMove)
    window.addEventListener('pointerup', onHandleUp, { once: true })
  }

  function onHandleMove(event: PointerEvent) {
    const r = resizing
    if (!r) return
    const at = r.axis === 'col' ? event.clientX : event.clientY
    resizing = { ...r, px: Math.max(MIN_PX[r.axis], Math.round(r.base + at - r.from)) }
  }

  function onHandleUp() {
    window.removeEventListener('pointermove', onHandleMove)
    const r = resizing
    resizing = null
    if (r && r.px !== r.base) onresize?.(r.axis, r.index, r.px)
    focus()
  }

  const guideStyle = (r: Resizing) =>
    r.axis === 'col'
      ? `left: ${LEFT_OFF + colLefts[r.index]! + r.px - 1 + (r.index < fc ? scrollLeft : 0)}px; top: ${OUT_H}px; width: 2px; height: ${HEAD_H + rowTops[rows]!}px;`
      : `top: ${TOP_OFF + rowTops[r.index]! + r.px - 1 + (r.index < fr ? scrollTop : 0)}px; left: ${OUT_W}px; height: 2px; width: ${HEAD_W + colLefts[cols]!}px;`

  const inSel = (r: number, c: number) =>
    allSelections.some((rg) => rangeContains(rg, { row: r, col: c }))

  const filterButtonAt = (r: number, c: number) =>
    !!filter && filter.ranges.some((x) => r === x.top && c >= x.left && c <= x.right)

  function openFilter(c: number, el: Element | null, r: number) {
    if (!el || !onfilter) return
    if (editing) finishEdit(true)
    onfilter(c, el.getBoundingClientRect(), r)
  }

  function clampBoxToGrid(r: Range) {
    return box({
      top: Math.max(0, Math.min(rows - 1, r.top)),
      bottom: Math.max(0, Math.min(rows - 1, r.bottom)),
      left: Math.max(0, Math.min(cols - 1, r.left)),
      right: Math.max(0, Math.min(cols - 1, r.right)),
    })
  }
</script>

{#snippet pane(rowList: number[], colList: number[], dx: number, dy: number, quad: string)}
  {#each rowList as r (r)}
    <div
      role="row"
      aria-rowindex={r + 1}
      class="g-abs g-left"
      style="top: {rowTops[r]! - dy}px; height: {rowHeight(r)}px; width: {colLefts[cols]! - dx}px;"
    >
      {#each colList as c (c)}
        {@const mr = mergeAt(r, c)}
        {#if !mr || mr.start}
          {@const cell = cellAt(r, c)}
          {@const b = mr ? box(mr.range) : null}
          {@const fb = filterButtonAt(r, c)}
          <div
            id="xlsx-cell-{r}-{c}"
            role="gridcell"
            aria-colindex={c + 1}
            aria-selected={inSel(r, c)}
            class="xlsx-cell g-abs g-top g-clip g-cell-{cell?.vertical ?? 'bottom'} {showGridlines
              ? 'border-r border-b border-border/60'
              : ''} px-1 leading-[18px] {cell?.wrap
              ? 'whitespace-pre-wrap'
              : 'whitespace-pre'} {cell?.kept ? 'xlsx-kept' : ''} {fb ? 'pr-5' : ''}"
            style="left: {colLefts[c]! - dx}px; width: {b ? b.width : colWidth(c)}px; height: {b
              ? b.height
              : rowHeight(r)}px; text-align: {cell?.align ?? 'left'}; {cell?.css ?? ''}"
            title={cell?.kept
              ? m.drive_sheet_kept_cell({ reason: cell.kept })
              : cell?.unreadFormat
                ? m.drive_sheet_unread_format()
                : undefined}
            data-ref="{colName(c)}{r + 1}"
            onmouseenter={(e) => {
              if (cell?.hasNote || cell?.thread)
                oncellhover?.({ row: r, col: c }, e.currentTarget.getBoundingClientRect())
            }}
            onmouseleave={() => {
              if (cell?.hasNote || cell?.thread) oncellhover?.(null, null)
            }}
          >
            {#if cell?.imageUrl}
              <img
                src={cell.imageUrl}
                alt={cell.imageAlt ?? ''}
                class="pointer-events-none block h-full w-full object-contain"
                data-testid="xlsx-cell-image"
              />
            {:else}
            <span class="block">
              {#if cell?.runs && cell.runs.length > 0}
                {#each cell.runs as run, rIdx (rIdx)}
                  <span style={runCss(run)}>{run.text}</span>
                {/each}
              {:else}
                {cell?.text ?? ''}
              {/if}
            </span>
            {/if}
            {#if cell?.hasNote}
              {@const noteLabel = m.drive_sheet_cell_has_note({ ref: `${colName(c)}${r + 1}` })}
              <button
                type="button"
                tabindex="-1"
                class="g-note-corner"
                style="right: {fb ? 18 : 0}px;"
                aria-label={noteLabel}
                title={noteLabel}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => {
                  e.stopPropagation()
                  onnoteopen?.({ row: r, col: c }, e.currentTarget.getBoundingClientRect())
                }}
                data-testid="xlsx-note-indicator"
              ></button>
            {:else if cell?.thread}
              {@const threadLabel = m.drive_sheet_cell_has_comments({
                count: cell.thread.count,
                ref: `${colName(c)}${r + 1}`,
              })}
              <button
                type="button"
                tabindex="-1"
                class="g-thread-corner {cell.thread.resolved ? 'g-thread-resolved' : ''}"
                style="right: {fb ? 18 : 0}px;"
                aria-label={threadLabel}
                title={threadLabel}
                onpointerdown={(e) => e.stopPropagation()}
                onclick={(e) => {
                  e.stopPropagation()
                  onnoteopen?.({ row: r, col: c }, e.currentTarget.getBoundingClientRect())
                }}
                data-testid="xlsx-comment-indicator"
              ></button>
            {/if}
            {#if fb}
              {@const on = filter!.filtered(r, c)}
              {@const what = on
                ? m.drive_sheet_filter_button_on({ col: colName(c) })
                : m.drive_sheet_filter_button({ col: colName(c) })}
              <button
                type="button"
                tabindex="-1"
                class="g-filter-btn inline-flex items-center justify-center rounded-sm border border-border bg-background hover:text-foreground {on
                  ? 'text-primary'
                  : 'text-muted-foreground'}"
                aria-haspopup="dialog"
                aria-label={what}
                title={what}
                onpointerdown={(e) => e.stopPropagation()}
                ondblclick={(e) => e.stopPropagation()}
                onclick={(e) => openFilter(c, e.currentTarget, r)}
                data-testid="xlsx-filter-button"
                data-col={colName(c)}
                >{#if on}<FunnelIcon class="size-3" aria-hidden="true" />{:else}<ChevronDownIcon
                    class="size-3"
                    aria-hidden="true"
                  />{/if}</button
              >
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/each}
  {#each extraSelections as er, idx (idx)}
    {@const eb = clampBoxToGrid(er)}
    <div
      class="g-abs g-ghost border border-primary/80 bg-primary/5"
      style="top: {eb.top - dy}px; left: {eb.left -
        dx}px; width: {eb.width}px; height: {eb.height}px;"
      aria-hidden="true"
    ></div>
  {/each}
  <div
    class="g-abs g-ghost border border-primary bg-primary/5"
    style="top: {selBox.top - dy}px; left: {selBox.left -
      dx}px; width: {selBox.width}px; height: {selBox.height}px;"
    aria-hidden="true"
  ></div>
  {#if cutRange}
    {@const cb = clampBoxToGrid(cutRange)}
    <div
      class="g-abs g-ghost border-2 border-dashed border-primary"
      style="top: {cb.top - dy}px; left: {cb.left -
        dx}px; width: {cb.width}px; height: {cb.height}px;"
      aria-hidden="true"
      data-testid="xlsx-cut-outline"
    ></div>
  {/if}
  {#if fillDrag}
    {@const fbBox = clampBoxToGrid(fillDrag.target)}
    <div
      class="g-abs g-ghost border-2 border-dashed border-primary bg-primary/10"
      style="top: {fbBox.top - dy}px; left: {fbBox.left -
        dx}px; width: {fbBox.width}px; height: {fbBox.height}px;"
      aria-hidden="true"
      data-testid="xlsx-fill-preview"
    ></div>
  {/if}
  {#each formulaRefs as ref, i (ref.raw + i)}
    {@const rb = clampBoxToGrid(ref.range)}
    <div
      class="g-abs g-ghost border-2 border-dashed"
      style="top: {rb.top - dy}px; left: {rb.left -
        dx}px; width: {rb.width}px; height: {rb.height}px; border-color: {ref.color}; background-color: {ref.color}14;"
      aria-hidden="true"
      data-testid="xlsx-formula-ref-box"
    ></div>
  {/each}
  <div
    class="g-abs g-ghost border-2 border-primary"
    style="top: {activeBox.top - dy - 1}px; left: {activeBox.left -
      dx -
      1}px; width: {activeBox.width + 1}px; height: {activeBox.height + 1}px;"
    aria-hidden="true"
    data-testid={quad === activeQuad ? 'xlsx-active' : undefined}
  ></div>
  {#if editable && !editing && onfill && quad === fillQuad}
    <div
      class="g-abs g-fill-handle border border-background bg-primary"
      style="top: {selBox.top - dy + selBox.height - 4}px; left: {selBox.left -
        dx +
        selBox.width -
        4}px;"
      role="button"
      tabindex="-1"
      aria-label={m.drive_sheet_fill_handle()}
      title={m.drive_sheet_fill_handle()}
      onpointerdown={onFillHandleDown}
      ondblclick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onfilldblclick?.(sel)
      }}
      data-testid="xlsx-fill-handle"
    ></div>
  {/if}
  {#if editing && quad === activeQuad}
    <textarea
      bind:this={cellEditor}
      bind:value={draft}
      class="g-abs g-editor resize-none border-2 border-primary bg-background px-1 leading-[18px] shadow-md outline-none focus:border-primary"
      style="top: {activeBox.top - dy - 1}px; left: {activeBox.left -
        dx -
        1}px; min-width: {activeBox.width + 1}px; height: {Math.max(activeBox.height + 1, 24)}px;"
      aria-label={m.drive_sheet_cell_editor({
        ref: `${colName(active.col)}${active.row + 1}`,
      })}
      spellcheck="false"
      oninput={syncEditorCursor}
      onclick={syncEditorCursor}
      onkeyup={syncEditorCursor}
      onkeydown={onEditorKeydown}
      onblur={(e) => {
        const rel = e.relatedTarget
        if (rel instanceof HTMLElement && rel.hasAttribute('data-xlsx-formula-bar')) return
        finishEdit(true, 'none', false)
      }}
      data-testid="xlsx-cell-editor"></textarea>
  {/if}
{/snippet}

{#snippet colHead(c: number, dx: number)}
  <button
    type="button"
    tabindex="-1"
    role="columnheader"
    aria-colindex={c + 1}
    class="g-abs g-top border-r border-b border-border bg-muted text-center text-xs text-muted-foreground {c >=
      sel.left && c <= sel.right
      ? 'bg-primary/10 font-medium text-foreground'
      : ''}"
    style="left: {colLefts[c]! - dx}px; width: {colWidth(c)}px; height: {HEAD_H}px;"
    onclick={(e) => pickColumn(c, e.shiftKey, e.ctrlKey || e.metaKey)}>{colName(c)}</button
  >
  {#if onresize && editable}
    <div
      class="g-abs g-top g-col-handle"
      style="left: {colLefts[c + 1]! - dx - 3}px; height: {HEAD_H}px;"
      role="separator"
      aria-orientation="vertical"
      aria-label={m.drive_sheet_fmt_col_resize({ col: colName(c) })}
      onpointerdown={(e) => onHandleDown(e, 'col', c)}
      ondblclick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onautofit?.('col', c)
      }}
      data-testid="xlsx-col-resize-{colName(c)}"
    ></div>
  {/if}
{/snippet}

{#snippet rowHead(r: number, dy: number)}
  <button
    type="button"
    tabindex="-1"
    class="g-abs g-full-w border-r border-b border-border bg-muted pr-1.5 text-right text-xs text-muted-foreground tabular-nums {r >=
      sel.top && r <= sel.bottom
      ? 'bg-primary/10 font-medium text-foreground'
      : ''}"
    style="top: {rowTops[r]! - dy}px; height: {rowHeight(r)}px;"
    aria-label={m.drive_sheet_row_label({ n: r + 1 })}
    onclick={(e) => pickRow(r, e.shiftKey, e.ctrlKey || e.metaKey)}>{r + 1}</button
  >
  {#if onresize && editable}
    <div
      class="g-abs g-full-w g-row-handle"
      style="top: {rowTops[r + 1]! - dy - 3}px;"
      role="separator"
      aria-orientation="horizontal"
      aria-label={m.drive_sheet_fmt_row_resize({ row: r + 1 })}
      onpointerdown={(e) => onHandleDown(e, 'row', r)}
      ondblclick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onautofit?.('row', r)
      }}
      data-testid="xlsx-row-resize-{r + 1}"
    ></div>
  {/if}
{/snippet}

<div
  bind:this={scroller}
  class="xlsx-grid g-scroller bg-background text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
  role="grid"
  tabindex="0"
  aria-label={label}
  aria-rowcount={rows}
  aria-colcount={cols}
  aria-multiselectable="true"
  aria-readonly={!editable}
  aria-activedescendant={activeId}
  onscroll={onScroll}
  onkeydown={onKeydown}
  oncopy={onCopy}
  oncut={onCut}
  onpaste={onPaste}
  data-testid="xlsx-grid"
>
  <div
    class="g-canvas"
    style="width: {LEFT_OFF + colLefts[cols]!}px; height: {TOP_OFF + rowTops[rows]!}px;"
    role="presentation"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    ondblclick={(e) => {
      if (!pointSelectMode && posFromEvent(e)) void beginEdit(null)
    }}
  >
    {#if resizing}
      <div
        class="g-abs g-ghost g-guide bg-primary"
        style={guideStyle(resizing)}
        aria-hidden="true"
        data-testid="xlsx-resize-guide"
      ></div>
    {/if}

    {#if hasColOutline && outline}
      <div
        class="g-head g-col-outline border-b border-border bg-muted/70"
        style="height: {OUT_H}px; width: {LEFT_OFF + colLefts[cols]!}px;"
      >
        <div
          class="g-corner flex shrink-0 items-center justify-center gap-0.5 border-r border-border bg-muted px-0.5"
          style="width: {LEFT_OFF}px; min-width: {LEFT_OFF}px;"
        >
          {#each Array.from({ length: outline.maxColLevel + 1 }, (_, i) => i + 1) as lvl (lvl)}
            <button
              type="button"
              class="inline-flex size-4 items-center justify-center rounded border border-border bg-background text-[10px] hover:bg-accent"
              title={m.drive_sheet_outline_level({ level: lvl })}
              onclick={(e) => {
                e.stopPropagation()
                onoutline?.({ axis: 'col', kind: 'level', level: lvl })
              }}
              data-testid="xlsx-outline-col-level-{lvl}">{lvl}</button
            >
          {/each}
        </div>
        <div class="g-rel" style="width: {colLefts[cols]!}px;">
          {#each outline.cols as g (`c-${g.level}-${g.from}-${g.to}`)}
            {@const xIdx = Math.max(0, Math.min(cols - 1, g.summaryAt))}
            <button
              type="button"
              class="g-abs top-0.5 inline-flex size-4 items-center justify-center rounded border border-border bg-background text-[11px] leading-none hover:bg-accent"
              style="left: {colLefts[xIdx]! + 2}px;"
              title={m.drive_sheet_outline_toggle()}
              onclick={(e) => {
                e.stopPropagation()
                onoutline?.({
                  axis: 'col',
                  kind: 'toggle',
                  from: g.from,
                  to: g.to,
                  collapsed: !g.collapsed,
                })
              }}
              data-testid="xlsx-outline-col-toggle-{g.from}-{g.to}"
              >{g.collapsed ? '+' : '−'}</button
            >
          {/each}
        </div>
      </div>
    {/if}

    {#if showHeadings}
      <div
        class="g-head"
        style="top: {OUT_H}px; height: {HEAD_H}px; width: {LEFT_OFF + colLefts[cols]!}px;"
        role="row"
      >
        {#if hasRowOutline && outline}
          <div
            class="g-corner flex shrink-0 items-center justify-center gap-0.5 border-r border-b border-border bg-muted"
            style="width: {OUT_W}px; min-width: {OUT_W}px;"
          >
            {#each Array.from({ length: Math.min(2, outline.maxRowLevel + 1) }, (_, i) => i + 1) as lvl (lvl)}
              <button
                type="button"
                class="inline-flex size-3.5 items-center justify-center rounded border border-border bg-background text-[9px] hover:bg-accent"
                title={m.drive_sheet_outline_level({ level: lvl })}
                onclick={(e) => {
                  e.stopPropagation()
                  onoutline?.({ axis: 'row', kind: 'level', level: lvl })
                }}
                data-testid="xlsx-outline-row-level-{lvl}">{lvl}</button
              >
            {/each}
          </div>
        {/if}
        <div
          class="g-corner border-r border-b border-border bg-muted"
          style="width: {HEAD_W}px; min-width: {HEAD_W}px; {hasRowOutline
            ? `left: ${OUT_W}px;`
            : ''}"
          role="columnheader"
          aria-label={m.drive_sheet_corner()}
        ></div>
        {#if fc > 0}
          <div
            class="g-rel g-stick-l g-z25 bg-muted"
            style="width: {FW}px; min-width: {FW}px; left: {LEFT_OFF}px;"
          >
            {#each frozenColList as c (c)}{@render colHead(c, 0)}{/each}
          </div>
        {/if}
        <div class="g-rel" style="width: {colLefts[cols]! - FW}px;">
          {#each visibleCols as c (c)}{@render colHead(c, FW)}{/each}
        </div>
      </div>
    {/if}

    {#if fr > 0}
      <div
        class="g-frozen-rows"
        style="top: {TOP_OFF}px; height: {FH}px; width: {LEFT_OFF + colLefts[cols]!}px;"
        data-testid="xlsx-frozen-rows"
      >
        {#if hasRowOutline && outline}
          <div
            class="g-outline-rows g-stick-l border-r border-border bg-muted/60"
            style="left: 0; width: {OUT_W}px; min-width: {OUT_W}px; height: {FH}px; z-index: 18;"
          ></div>
        {/if}
        {#if showHeadings}
          <div
            class="g-rowheads bg-muted"
            style="width: {HEAD_W}px; min-width: {HEAD_W}px; height: {FH}px; left: {OUT_W}px;"
          >
            {#each frozenRowList as r (r)}{@render rowHead(r, 0)}{/each}
          </div>
        {/if}
        {#if fc > 0}
          <div
            class="g-rel g-stick-l g-z16 g-clip g-freeze-line-r bg-background"
            style="width: {FW}px; min-width: {FW}px; height: {FH}px; left: {LEFT_OFF}px;"
          >
            {@render pane(frozenRowList, frozenColList, 0, 0, 'tl')}
          </div>
        {/if}
        <div
          class="g-rel g-clip bg-background"
          style="width: {colLefts[cols]! - FW}px; height: {FH}px;"
        >
          {@render pane(frozenRowList, visibleCols, FW, 0, 'tr')}
        </div>
      </div>
    {/if}

    <div class="g-body" style="height: {rowTops[rows]! - FH}px;">
      {#if hasRowOutline && outline}
        <div
          class="g-outline-rows g-stick-l border-r border-border bg-muted/60"
          style="left: 0; width: {OUT_W}px; min-width: {OUT_W}px; height: {rowTops[rows]! -
            FH}px; z-index: 11;"
        >
          {#each outline.rows as g (`r-${g.level}-${g.from}-${g.to}`)}
            {@const rIdx = Math.max(fr, Math.min(rows - 1, g.summaryAt))}
            <button
              type="button"
              class="g-abs left-0.5 inline-flex size-4 items-center justify-center rounded border border-border bg-background text-[11px] leading-none hover:bg-accent"
              style="top: {rowTops[rIdx]! - FH + 2}px;"
              title={m.drive_sheet_outline_toggle()}
              onclick={(e) => {
                e.stopPropagation()
                onoutline?.({
                  axis: 'row',
                  kind: 'toggle',
                  from: g.from,
                  to: g.to,
                  collapsed: !g.collapsed,
                })
              }}
              data-testid="xlsx-outline-row-toggle-{g.from}-{g.to}"
              >{g.collapsed ? '+' : '−'}</button
            >
          {/each}
        </div>
      {/if}
      {#if showHeadings}
        <div
          class="g-rowheads bg-muted"
          style="width: {HEAD_W}px; min-width: {HEAD_W}px; height: {rowTops[rows]! -
            FH}px; left: {OUT_W}px;"
        >
          {#each visibleRows as r (r)}{@render rowHead(r, FH)}{/each}
        </div>
      {/if}
      {#if fc > 0}
        <div
          class="g-rel g-stick-l g-z12 g-clip g-freeze-line-r bg-background"
          style="width: {FW}px; min-width: {FW}px; height: {rowTops[rows]! -
            FH}px; left: {LEFT_OFF}px;"
          data-testid="xlsx-frozen-cols"
        >
          {@render pane(visibleRows, frozenColList, 0, FH, 'bl')}
        </div>
      {/if}
      <div
        class="g-rel"
        style="width: {colLefts[cols]! - FW}px; height: {rowTops[rows]! - FH}px;"
        role="presentation"
      >
        {@render pane(visibleRows, visibleCols, FW, FH, 'br')}
        {@render overlay?.({ dx: FW, dy: FH })}
      </div>
    </div>
  </div>
</div>

<style>
  .g-scroller {
    position: relative;
    flex: 1 1 auto;
    min-height: 16rem;
    max-height: calc(100vh - 16rem);
    overflow: auto;
  }
  .g-canvas,
  .g-rel {
    position: relative;
  }
  .g-head {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
  }
  .g-col-outline {
    z-index: 22;
  }
  .g-corner {
    position: sticky;
    left: 0;
    z-index: 30;
  }
  .g-body {
    display: flex;
  }
  .g-frozen-rows {
    position: sticky;
    z-index: 15;
    display: flex;
  }
  .g-stick-l {
    position: sticky;
  }
  .g-frozen-rows::after,
  .g-freeze-line-r::after {
    content: '';
    position: absolute;
    z-index: 3;
    pointer-events: none;
    background: var(--muted-foreground);
    opacity: 0.6;
  }
  .g-frozen-rows::after {
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
  }
  .g-freeze-line-r::after {
    top: 0;
    bottom: 0;
    right: 0;
    width: 1px;
  }
  .g-z12 {
    z-index: 12;
  }
  .g-z16 {
    z-index: 16;
  }
  .g-z25 {
    z-index: 25;
  }
  .g-filter-btn {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 16px;
    height: 16px;
    z-index: 2;
  }
  .g-note-corner,
  .g-thread-corner {
    position: absolute;
    top: 0;
    width: 0;
    height: 0;
    padding: 0;
    border-style: solid;
    border-width: 0 9px 9px 0;
    border-color: transparent #dc2626 transparent transparent;
    background: transparent;
    cursor: pointer;
    z-index: 2;
  }
  .g-thread-corner {
    border-color: transparent #7c3aed transparent transparent;
  }
  .g-thread-resolved {
    border-color: transparent #a78bfa transparent transparent;
  }
  .g-rowheads {
    position: sticky;
    left: 0;
    z-index: 10;
  }
  .g-outline-rows {
    position: relative;
  }
  .g-abs {
    position: absolute;
    box-sizing: border-box;
  }
  .g-top {
    top: 0;
  }
  .g-left {
    left: 0;
  }
  .g-full-w {
    left: 0;
    right: 0;
  }
  .g-clip {
    overflow: hidden;
  }
  .g-ghost {
    pointer-events: none;
  }
  .g-fill-handle {
    width: 8px;
    height: 8px;
    z-index: 6;
    cursor: crosshair;
  }
  .g-editor {
    z-index: 5;
  }
  .g-cell-top,
  .g-cell-center,
  .g-cell-bottom {
    display: flex;
    flex-direction: column;
  }
  .g-cell-top {
    justify-content: flex-start;
  }
  .g-cell-center {
    justify-content: center;
  }
  .g-cell-bottom {
    justify-content: flex-end;
  }
  .g-col-handle {
    width: 6px;
    z-index: 2;
    cursor: col-resize;
    touch-action: none;
  }
  .g-row-handle {
    height: 6px;
    z-index: 2;
    cursor: row-resize;
    touch-action: none;
  }
  .g-guide {
    z-index: 40;
  }
  .xlsx-grid :global(.xlsx-kept) {
    background-image: linear-gradient(135deg, var(--muted-foreground) 0 4px, transparent 4px);
    background-size: 100% 100%;
    background-repeat: no-repeat;
  }
</style>
