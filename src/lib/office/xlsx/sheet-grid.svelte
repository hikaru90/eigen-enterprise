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

  const firstRow = $derived(Math.max(0, indexAt(rowTops, scrollTop) - OVERSCAN))
  const lastRow = $derived(Math.min(rows - 1, indexAt(rowTops, scrollTop + viewH) + OVERSCAN))
  const firstCol = $derived(Math.max(0, indexAt(colLefts, scrollLeft) - OVERSCAN))
  const lastCol = $derived(Math.min(cols - 1, indexAt(colLefts, scrollLeft + viewW) + OVERSCAN))
  const visibleRows = $derived(
    Array.from({ length: Math.max(0, lastRow - firstRow + 1) }, (_, i) => firstRow + i),
  )
  const visibleCols = $derived(
    Array.from({ length: Math.max(0, lastCol - firstCol + 1) }, (_, i) => firstCol + i),
  )

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
    if (b.top < scroller.scrollTop) scroller.scrollTop = b.top
    else if (b.top + b.height > scroller.scrollTop + bodyH)
      scroller.scrollTop = b.top + b.height - bodyH
    if (b.left < scroller.scrollLeft) scroller.scrollLeft = b.left
    else if (b.left + b.width > scroller.scrollLeft + bodyW)
      scroller.scrollLeft = b.left + b.width - bodyW
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
    const x = event.clientX - rect.left - HEAD_W + scroller.scrollLeft
    const y = event.clientY - rect.top - HEAD_H + scroller.scrollTop
    if (x < 0 || y < 0) return null
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
      ? `left: ${HEAD_W + colLefts[r.index]! + r.px - 1}px; top: 0; width: 2px; height: ${HEAD_H + rowTops[rows]!}px;`
      : `top: ${HEAD_H + rowTops[r.index]! + r.px - 1}px; left: 0; height: 2px; width: ${HEAD_W + colLefts[cols]!}px;`

  const inSel = (r: number, c: number) =>
    r >= sel.top && r <= sel.bottom && c >= sel.left && c <= sel.right
</script>

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
      <div class="g-rel" style="width: {colLefts[cols]!}px;">
        {#each visibleCols as c (c)}
          <button
            type="button"
            tabindex="-1"
            role="columnheader"
            aria-colindex={c + 1}
            class="g-abs g-top border-r border-b border-border bg-muted text-center text-xs text-muted-foreground {c >=
              sel.left && c <= sel.right
              ? 'bg-primary/10 font-medium text-foreground'
              : ''}"
            style="left: {colLefts[c]}px; width: {colWidth(c)}px; height: {HEAD_H}px;"
            onclick={(e) => pickColumn(c, e.shiftKey)}>{colName(c)}</button
          >
          {#if onresize && editable}
            <div
              class="g-abs g-top g-col-handle"
              style="left: {colLefts[c + 1]! - 3}px; height: {HEAD_H}px;"
              role="separator"
              aria-orientation="vertical"
              aria-label={m.drive_sheet_fmt_col_resize({ col: colName(c) })}
              onpointerdown={(e) => onHandleDown(e, 'col', c)}
              data-testid="xlsx-col-resize-{colName(c)}"
            ></div>
          {/if}
        {/each}
      </div>
    </div>
    <div class="g-body" style="height: {rowTops[rows]!}px;">
      <!-- Row numbers -->
      <div
        class="g-rowheads bg-muted"
        style="width: {HEAD_W}px; min-width: {HEAD_W}px; height: {rowTops[rows]!}px;"
      >
        {#each visibleRows as r (r)}
          <button
            type="button"
            tabindex="-1"
            class="g-abs g-full-w border-r border-b border-border bg-muted pr-1.5 text-right text-xs text-muted-foreground tabular-nums {r >=
              sel.top && r <= sel.bottom
              ? 'bg-primary/10 font-medium text-foreground'
              : ''}"
            style="top: {rowTops[r]}px; height: {rowHeight(r)}px;"
            aria-label={m.drive_sheet_row_label({ n: r + 1 })}
            onclick={(e) => pickRow(r, e.shiftKey)}>{r + 1}</button
          >
          {#if onresize && editable}
            <div
              class="g-abs g-full-w g-row-handle"
              style="top: {rowTops[r + 1]! - 3}px;"
              role="separator"
              aria-orientation="horizontal"
              aria-label={m.drive_sheet_fmt_row_resize({ row: r + 1 })}
              onpointerdown={(e) => onHandleDown(e, 'row', r)}
              data-testid="xlsx-row-resize-{r + 1}"
            ></div>
          {/if}
        {/each}
      </div>
      <!-- Cells -->
      <div
        class="g-rel"
        style="width: {colLefts[cols]!}px; height: {rowTops[rows]!}px;"
        role="presentation"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        ondblclick={() => void beginEdit(null)}
      >
        {#each visibleRows as r (r)}
          <div
            role="row"
            aria-rowindex={r + 1}
            class="g-abs g-left"
            style="top: {rowTops[r]}px; height: {rowHeight(r)}px; width: {colLefts[cols]!}px;"
          >
            {#each visibleCols as c (c)}
              {@const mr = mergeAt(r, c)}
              {#if !mr || mr.start}
                {@const cell = cellAt(r, c)}
                {@const b = mr ? box(mr.range) : null}
                <div
                  id="xlsx-cell-{r}-{c}"
                  role="gridcell"
                  aria-colindex={c + 1}
                  aria-selected={inSel(r, c)}
                  class="xlsx-cell g-abs g-top g-clip g-cell-{cell?.vertical ??
                    'bottom'} border-r border-b border-border/60 px-1 leading-[18px] {cell?.wrap
                    ? 'whitespace-pre-wrap'
                    : 'whitespace-pre'} {cell?.kept ? 'xlsx-kept' : ''}"
                  style="left: {colLefts[c]}px; width: {b ? b.width : colWidth(c)}px; height: {b
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
                </div>
              {/if}
            {/each}
          </div>
        {/each}
        <!-- Selection -->
        <div
          class="g-abs g-ghost border border-primary bg-primary/5"
          style="top: {selBox.top}px; left: {selBox.left}px; width: {selBox.width}px; height: {selBox.height}px;"
          aria-hidden="true"
        ></div>
        <div
          class="g-abs g-ghost border-2 border-primary"
          style="top: {activeBox.top - 1}px; left: {activeBox.left - 1}px; width: {activeBox.width +
            1}px; height: {activeBox.height + 1}px;"
          aria-hidden="true"
          data-testid="xlsx-active"
        ></div>
        {#if editing}
          <textarea
            bind:this={cellEditor}
            bind:value={draft}
            class="g-abs g-editor resize-none border-2 border-primary bg-background px-1 leading-[18px] shadow-md outline-none focus:border-primary"
            style="top: {activeBox.top - 1}px; left: {activeBox.left -
              1}px; min-width: {activeBox.width + 1}px; height: {Math.max(
              activeBox.height + 1,
              24,
            )}px;"
            aria-label={m.drive_sheet_cell_editor({
              ref: `${colName(active.col)}${active.row + 1}`,
            })}
            spellcheck="false"
            onkeydown={onEditorKeydown}
            onblur={() => finishEdit(true)}
            data-testid="xlsx-cell-editor"></textarea>
        {/if}
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
