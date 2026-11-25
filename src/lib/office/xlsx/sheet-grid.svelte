<script lang="ts" module>
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
  }
  export type Pos = { row: number; col: number }
  export type Move = 'down' | 'up' | 'right' | 'left' | 'none'
</script>

<script lang="ts">
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import FunnelIcon from '@lucide/svelte/icons/funnel'
  import { onMount, tick } from 'svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { colName, type Range } from './ref'

  /**
   * The sheet's cells as a grid (only the visible part is drawn): column
   * letters and row numbers, the cells with their formats, merged ranges,
   * the selection. Click or arrow keys move, Shift extends, a row or column
   * header picks the whole line. When `editable`: typing starts editing (or
   * Enter/F2/double-click with the cell's content), Enter/Tab commit and move,
   * Esc cancels, Delete clears the selection, paste fills from the active
   * cell. The page owns what an edit means (`oncommit`, `onclear`, `onpaste`).
   * Frozen rows/columns stay in place while the rest scrolls (sticky panes);
   * an AutoFilter puts a drop-down button in each cell of its header row
   * (Alt+↓ on a header cell opens it too), the page shows the menu.
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
    editing = $bindable(false),
    draft = $bindable(''),
    editTextOf,
    oncommit,
    onclear,
    onpaste,
    copyText,
    onreach,
    onblocked,
    frozenRows = 0,
    frozenCols = 0,
    filter = null,
    onfilter,
    onresize,
  }: {
    rows: number
    cols: number
    colWidth: (c: number) => number
    rowHeight: (r: number) => number
    cellAt: (r: number, c: number) => GridCell | null
    merges: Range[]
    /** Bumped by the page whenever the workbook changed (sizes are measured again; `cellAt` is a new function then too). */
    rev: number
    editable: boolean
    label: string
    active?: Pos
    anchor?: Pos
    editing?: boolean
    draft?: string
    editTextOf: (r: number, c: number) => string
    oncommit: (pos: Pos, text: string, move: Move) => void
    onclear: (range: Range) => void
    onpaste: (pos: Pos, text: string) => void
    copyText: (range: Range) => string
    /** Scrolled near the last drawn row or column: the page may grow the grid. */
    onreach?: (axis: 'row' | 'col') => void
    /** A key that would edit while editing is not allowed (view only). */
    onblocked?: () => void
    /** Rows from the top / columns from the left that stay in place. */
    frozenRows?: number
    frozenCols?: number
    /** The sheet's AutoFilter and its tables' filters: their ranges (drop-downs on each first row), and which columns filter. */
    filter?: { ranges: Range[]; filtered: (row: number, col: number) => boolean } | null
    /** A filter button (or Alt+↓) asked for the menu of column `col` of the filter whose header row is `row`, shown at `at`. */
    onfilter?: (col: number, at: DOMRect, row: number) => void
    /** A column's or row's edge was dragged to a new size (pixels); without it there are no drag handles. */
    onresize?: (axis: 'col' | 'row', index: number, px: number) => void
  } = $props()

  const HEAD_H = 24
  const HEAD_W = 48
  const OVERSCAN = 4

  let scroller = $state<HTMLDivElement | null>(null)
  let cellEditor = $state<HTMLTextAreaElement | null>(null)
  let scrollTop = $state(0)
  let scrollLeft = $state(0)
  let viewW = $state(800)
  let viewH = $state(400)
  let dragging = false

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

  /** The index whose span holds `x` in prefix offsets `at`. */
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
  /** The pane the active cell is drawn in (the cell editor goes there). */
  const activeQuad = $derived(`${active.row < fr ? 't' : 'b'}${active.col < fc ? 'l' : 'r'}`)

  const sel = $derived<Range>({
    top: Math.min(active.row, anchor.row),
    bottom: Math.max(active.row, anchor.row),
    left: Math.min(active.col, anchor.col),
    right: Math.max(active.col, anchor.col),
  })

  /** The merged range a cell starts (drawn across it), or covers (not drawn). */
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

  /** Scrolls the active cell into view. */
  function reveal() {
    if (!scroller) return
    const b = activeBox
    const bodyH = scroller.clientHeight - HEAD_H
    const bodyW = scroller.clientWidth - HEAD_W
    // Cells in frozen rows/columns are always in view on that axis.
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

  function moveTo(row: number, col: number, extend = false) {
    const next = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
    active = next
    if (!extend) anchor = next
    void tick().then(reveal)
  }

  function step(move: Move, extend = false) {
    const mr = mergeAt(active.row, active.col)?.range
    const r = active.row
    const c = active.col
    if (move === 'down') moveTo((mr && !extend ? mr.bottom : r) + 1, c, extend)
    else if (move === 'up') moveTo(r - 1, c, extend)
    else if (move === 'right') moveTo(r, (mr && !extend ? mr.right : c) + 1, extend)
    else if (move === 'left') moveTo(r, c - 1, extend)
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
  }

  /** Ends editing: the text goes to the page (`commit`) or is dropped. */
  export function finishEdit(commit: boolean, move: Move = 'none') {
    if (!editing) return
    editing = false
    const text = draft
    if (commit) oncommit({ ...active }, text, move)
    if (commit && move !== 'none') step(move)
    focus()
  }

  export function startEdit(initial: string | null = null) {
    void beginEdit(initial)
  }

  function onKeydown(event: KeyboardEvent) {
    if (editing || event.defaultPrevented) return
    const mod = event.metaKey || event.ctrlKey
    const ext = event.shiftKey
    if (event.altKey && event.key === 'ArrowDown' && filterButtonAt(active.row, active.col)) {
      event.preventDefault()
      openFilter(active.col, document.getElementById(activeId), active.row)
      return
    }
    switch (event.key) {
      case 'ArrowDown':
        step('down', ext)
        break
      case 'ArrowUp':
        step('up', ext)
        break
      case 'ArrowRight':
        step('right', ext)
        break
      case 'ArrowLeft':
        step('left', ext)
        break
      case 'Tab':
        step(ext ? 'left' : 'right')
        break
      case 'Enter':
        if (ext) step('up')
        else void beginEdit(null)
        break
      case 'F2':
        void beginEdit(null)
        break
      case 'Home':
        moveTo(mod ? 0 : active.row, 0, ext)
        break
      case 'PageDown':
        moveTo(active.row + Math.max(1, Math.floor(viewH / 20) - 2), active.col, ext)
        break
      case 'PageUp':
        moveTo(active.row - Math.max(1, Math.floor(viewH / 20) - 2), active.col, ext)
        break
      case 'Delete':
      case 'Backspace':
        if (!editable) onblocked?.()
        else onclear(sel)
        break
      case 'Escape':
        anchor = { ...active }
        break
      default:
        if (mod && event.key.toLowerCase() === 'a') {
          anchor = { row: 0, col: 0 }
          active = { row: rows - 1, col: cols - 1 }
          break
        }
        // A printable character starts editing with it (replacing the content).
        if (!mod && !event.altKey && event.key.length === 1) {
          void beginEdit(event.key)
          break
        }
        return
    }
    event.preventDefault()
  }

  function onEditorKeydown(event: KeyboardEvent) {
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

  function posFromEvent(event: PointerEvent | MouseEvent): Pos | null {
    if (!scroller) return null
    const rect = scroller.getBoundingClientRect()
    const vx = event.clientX - rect.left - HEAD_W
    const vy = event.clientY - rect.top - HEAD_H
    if (vx < 0 || vy < 0) return null
    // Frozen panes don't scroll.
    const x = vx < FW ? vx : vx + scroller.scrollLeft
    const y = vy < FH ? vy : vy + scroller.scrollTop
    return {
      row: Math.min(rows - 1, indexAt(rowTops, y)),
      col: Math.min(cols - 1, indexAt(colLefts, x)),
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    const p = posFromEvent(event)
    if (!p) return
    if (editing) finishEdit(true)
    const mr = mergeAt(p.row, p.col)
    const at = mr ? { row: mr.range.top, col: mr.range.left } : p
    if (event.shiftKey) active = at
    else {
      active = at
      anchor = at
    }
    dragging = true
    focus()
    event.preventDefault()
  }

  function onPointerMove(event: PointerEvent) {
    if (!dragging || !(event.buttons & 1)) return
    const p = posFromEvent(event)
    if (p && (p.row !== active.row || p.col !== active.col)) active = p
  }

  function onPointerUp() {
    dragging = false
  }

  function pickColumn(c: number, extend: boolean) {
    if (editing) finishEdit(true)
    if (!extend) anchor = { row: 0, col: c }
    else anchor = { row: 0, col: anchor.col }
    active = { row: rows - 1, col: c }
    focus()
  }

  function pickRow(r: number, extend: boolean) {
    if (editing) finishEdit(true)
    if (!extend) anchor = { row: r, col: 0 }
    else anchor = { row: anchor.row, col: 0 }
    active = { row: r, col: cols - 1 }
    focus()
  }

  function onCopy(event: ClipboardEvent) {
    if (editing) return
    event.clipboardData?.setData('text/plain', copyText(sel))
    event.preventDefault()
  }

  function onPaste(event: ClipboardEvent) {
    if (editing) return
    event.preventDefault()
    if (!editable) {
      onblocked?.()
      return
    }
    const text = event.clipboardData?.getData('text/plain') ?? ''
    if (text !== '') onpaste({ row: sel.top, col: sel.left }, text)
  }

  // Dragging a column's right edge or a row's bottom edge: a guide line follows, the size is set on release.
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
      ? `left: ${HEAD_W + colLefts[r.index]! + r.px - 1 + (r.index < fc ? scrollLeft : 0)}px; top: 0; width: 2px; height: ${HEAD_H + rowTops[rows]!}px;`
      : `top: ${HEAD_H + rowTops[r.index]! + r.px - 1 + (r.index < fr ? scrollTop : 0)}px; left: 0; height: 2px; width: ${HEAD_W + colLefts[cols]!}px;`

  const inSel = (r: number, c: number) =>
    r >= sel.top && r <= sel.bottom && c >= sel.left && c <= sel.right

  const filterButtonAt = (r: number, c: number) =>
    !!filter && filter.ranges.some((x) => r === x.top && c >= x.left && c <= x.right)

  function openFilter(c: number, el: Element | null, r: number) {
    if (!el || !onfilter) return
    if (editing) finishEdit(true)
    onfilter(c, el.getBoundingClientRect(), r)
  }
</script>

<!-- One pane of cells (dx/dy: where it starts in sheet pixels) with its part of the selection, and the cell editor when the active cell is in it. -->
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
            class="xlsx-cell g-abs g-top g-clip g-cell-{cell?.vertical ??
              'bottom'} border-r border-b border-border/60 px-1 leading-[18px] {cell?.wrap
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
          >
            <span class="block">{cell?.text ?? ''}</span>
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
  <div
    class="g-abs g-ghost border border-primary bg-primary/5"
    style="top: {selBox.top - dy}px; left: {selBox.left -
      dx}px; width: {selBox.width}px; height: {selBox.height}px;"
    aria-hidden="true"
  ></div>
  <div
    class="g-abs g-ghost border-2 border-primary"
    style="top: {activeBox.top - dy - 1}px; left: {activeBox.left -
      dx -
      1}px; width: {activeBox.width + 1}px; height: {activeBox.height + 1}px;"
    aria-hidden="true"
    data-testid={quad === activeQuad ? 'xlsx-active' : undefined}
  ></div>
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
      onkeydown={onEditorKeydown}
      onblur={() => finishEdit(true)}
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
    onclick={(e) => pickColumn(c, e.shiftKey)}>{colName(c)}</button
  >
  {#if onresize && editable}
    <div
      class="g-abs g-top g-col-handle"
      style="left: {colLefts[c + 1]! - dx - 3}px; height: {HEAD_H}px;"
      role="separator"
      aria-orientation="vertical"
      aria-label={m.drive_sheet_fmt_col_resize({ col: colName(c) })}
      onpointerdown={(e) => onHandleDown(e, 'col', c)}
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
    onclick={(e) => pickRow(r, e.shiftKey)}>{r + 1}</button
  >
  {#if onresize && editable}
    <div
      class="g-abs g-full-w g-row-handle"
      style="top: {rowTops[r + 1]! - dy - 3}px;"
      role="separator"
      aria-orientation="horizontal"
      aria-label={m.drive_sheet_fmt_row_resize({ row: r + 1 })}
      onpointerdown={(e) => onHandleDown(e, 'row', r)}
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
  onpaste={onPaste}
  data-testid="xlsx-grid"
>
  <div
    class="g-canvas"
    style="width: {HEAD_W + colLefts[cols]!}px; height: {HEAD_H + rowTops[rows]!}px;"
    role="presentation"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    ondblclick={(e) => {
      if (posFromEvent(e)) void beginEdit(null)
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
    <!-- Column letters -->
    <div class="g-head" style="height: {HEAD_H}px; width: {HEAD_W + colLefts[cols]!}px;" role="row">
      <div
        class="g-corner border-r border-b border-border bg-muted"
        style="width: {HEAD_W}px; min-width: {HEAD_W}px;"
        role="columnheader"
        aria-label={m.drive_sheet_corner()}
      ></div>
      {#if fc > 0}
        <div
          class="g-rel g-stick-l g-z25 bg-muted"
          style="width: {FW}px; min-width: {FW}px; left: {HEAD_W}px;"
        >
          {#each frozenColList as c (c)}{@render colHead(c, 0)}{/each}
        </div>
      {/if}
      <div class="g-rel" style="width: {colLefts[cols]! - FW}px;">
        {#each visibleCols as c (c)}{@render colHead(c, FW)}{/each}
      </div>
    </div>
    {#if fr > 0}
      <!-- Frozen rows -->
      <div
        class="g-frozen-rows"
        style="top: {HEAD_H}px; height: {FH}px; width: {HEAD_W + colLefts[cols]!}px;"
        data-testid="xlsx-frozen-rows"
      >
        <div
          class="g-rowheads bg-muted"
          style="width: {HEAD_W}px; min-width: {HEAD_W}px; height: {FH}px;"
        >
          {#each frozenRowList as r (r)}{@render rowHead(r, 0)}{/each}
        </div>
        {#if fc > 0}
          <div
            class="g-rel g-stick-l g-z16 g-clip g-freeze-line-r bg-background"
            style="width: {FW}px; min-width: {FW}px; height: {FH}px; left: {HEAD_W}px;"
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
      <!-- Row numbers -->
      <div
        class="g-rowheads bg-muted"
        style="width: {HEAD_W}px; min-width: {HEAD_W}px; height: {rowTops[rows]! - FH}px;"
      >
        {#each visibleRows as r (r)}{@render rowHead(r, FH)}{/each}
      </div>
      {#if fc > 0}
        <!-- Frozen columns -->
        <div
          class="g-rel g-stick-l g-z12 g-clip g-freeze-line-r bg-background"
          style="width: {FW}px; min-width: {FW}px; height: {rowTops[rows]! -
            FH}px; left: {HEAD_W}px;"
          data-testid="xlsx-frozen-cols"
        >
          {@render pane(visibleRows, frozenColList, 0, FH, 'bl')}
        </div>
      {/if}
      <!-- Cells -->
      <div
        class="g-rel"
        style="width: {colLefts[cols]! - FW}px; height: {rowTops[rows]! - FH}px;"
        role="presentation"
      >
        {@render pane(visibleRows, visibleCols, FW, FH, 'br')}
      </div>
    </div>
  </div>
</div>

<style>
  /* Layout the grid needs to work at all (positions, scrolling), kept here rather than in utility classes. */
  .g-scroller {
    position: relative;
    flex: 1 1 auto;
    min-height: 16rem;
    max-height: calc(100vh - 14rem);
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
  /* The freeze line, as Excel draws it: below the frozen rows, right of the frozen columns. */
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
  .g-rowheads {
    position: sticky;
    left: 0;
    z-index: 10;
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
