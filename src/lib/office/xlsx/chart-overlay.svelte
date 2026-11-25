<script lang="ts">
  import type { Calc } from './calc'
  import type { ChartPlacement } from './chart-anchor'
  import type { ChartPosition } from './chart-ops'
  import type { SheetLocale } from './format'
  import type { Workbook } from './workbook'
  import PencilIcon from '@lucide/svelte/icons/pencil'
  import Trash2Icon from '@lucide/svelte/icons/trash-2'
  import { m } from '$lib/paraglide/messages.js'
  import { anchorBox, markerAt } from './chart-anchor'
  import ChartView from './chart-view.svelte'

  /**
   * Anchored charts drawn over a worksheet's grid: click to select, drag to
   * move, drag any of 8 handles to resize (committed as `chart_move`),
   * double-click or Edit to change properties, Delete to remove.
   */
  let {
    wb,
    calc,
    charts,
    colLeft,
    rowTop,
    maxCol,
    maxRow,
    locale,
    rev,
    editable,
    selected = $bindable<string | null>(null),
    onmove,
    onedit,
    ondelete,
  }: {
    wb: Workbook
    calc: () => Calc
    charts: ChartPlacement[]
    colLeft: (c: number) => number
    rowTop: (r: number) => number
    maxCol: number
    maxRow: number
    locale: SheetLocale
    rev: number
    editable: boolean
    selected?: string | null
    onmove: (chartId: string, to: ChartPosition) => void
    onedit: (placement: ChartPlacement) => void
    ondelete: (chartId: string) => void
  } = $props()

  type Box = { x: number; y: number; width: number; height: number }
  type Dir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
  type Drag =
    | { kind: 'move'; id: string; startX: number; startY: number; orig: Box; box: Box }
    | { kind: 'resize'; id: string; dir: Dir; startX: number; startY: number; orig: Box; box: Box }

  const MIN_W = 120
  const MIN_H = 80

  const HANDLES: Array<{ dir: Dir; style: string; cursor: string }> = [
    { dir: 'nw', style: 'top: -4px; left: -4px;', cursor: 'nwse-resize' },
    { dir: 'n', style: 'top: -4px; left: calc(50% - 4px);', cursor: 'ns-resize' },
    { dir: 'ne', style: 'top: -4px; right: -4px;', cursor: 'nesw-resize' },
    { dir: 'e', style: 'top: calc(50% - 4px); right: -4px;', cursor: 'ew-resize' },
    { dir: 'se', style: 'bottom: -4px; right: -4px;', cursor: 'nwse-resize' },
    { dir: 's', style: 'bottom: -4px; left: calc(50% - 4px);', cursor: 'ns-resize' },
    { dir: 'sw', style: 'bottom: -4px; left: -4px;', cursor: 'nesw-resize' },
    { dir: 'w', style: 'top: calc(50% - 4px); left: -4px;', cursor: 'ew-resize' },
  ]

  let drag = $state<Drag | null>(null)

  function boxOf(c: ChartPlacement): Box {
    void rev
    const b = anchorBox(c.anchor, colLeft, rowTop)
    return { x: b.x, y: b.y, width: Math.max(MIN_W, b.width), height: Math.max(MIN_H, b.height) }
  }

  function startMove(event: PointerEvent, c: ChartPlacement) {
    if (event.button !== 0) return
    event.stopPropagation()
    selected = c.id
    ;(event.currentTarget as HTMLElement).focus({ preventScroll: true })
    if (!editable || c.anchor.kind === 'absolute') return
    const orig = boxOf(c)
    drag = { kind: 'move', id: c.id, startX: event.clientX, startY: event.clientY, orig, box: orig }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  function startResize(event: PointerEvent, c: ChartPlacement, dir: Dir) {
    if (event.button !== 0 || !editable) return
    event.stopPropagation()
    event.preventDefault()
    selected = c.id
    const orig = boxOf(c)
    drag = {
      kind: 'resize',
      id: c.id,
      dir,
      startX: event.clientX,
      startY: event.clientY,
      orig,
      box: orig,
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }

  function onPointerMove(event: PointerEvent) {
    const d = drag
    if (!d) return
    const dx = event.clientX - d.startX
    const dy = event.clientY - d.startY
    if (d.kind === 'move') {
      drag = {
        ...d,
        box: { ...d.orig, x: Math.max(0, d.orig.x + dx), y: Math.max(0, d.orig.y + dy) },
      }
      return
    }
    let { x, y, width, height } = d.orig
    const right = d.orig.x + d.orig.width
    const bottom = d.orig.y + d.orig.height
    if (d.dir.includes('w')) {
      x = Math.max(0, Math.min(d.orig.x + dx, right - MIN_W))
      width = right - x
    }
    if (d.dir.includes('e')) width = Math.max(MIN_W, d.orig.width + dx)
    if (d.dir.includes('n')) {
      y = Math.max(0, Math.min(d.orig.y + dy, bottom - MIN_H))
      height = bottom - y
    }
    if (d.dir.includes('s')) height = Math.max(MIN_H, d.orig.height + dy)
    drag = { ...d, box: { x, y, width, height } }
  }

  function onPointerUp() {
    window.removeEventListener('pointermove', onPointerMove)
    const d = drag
    drag = null
    if (!d) return
    const { orig, box } = d
    if (
      Math.abs(box.x - orig.x) < 2 &&
      Math.abs(box.y - orig.y) < 2 &&
      Math.abs(box.width - orig.width) < 2 &&
      Math.abs(box.height - orig.height) < 2
    )
      return
    const from = markerAt(box.x, box.y, colLeft, rowTop, maxCol, maxRow)
    const to = markerAt(box.x + box.width, box.y + box.height, colLeft, rowTop, maxCol, maxRow)
    onmove(d.id, { from, to })
  }

  function onKeydown(event: KeyboardEvent, c: ChartPlacement) {
    if (!editable) return
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      event.stopPropagation()
      ondelete(c.id)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      onedit(c)
    } else if (event.key === 'Escape') {
      event.stopPropagation()
      selected = null
    }
  }
</script>

{#each charts as c (c.id)}
  {@const b = drag && drag.id === c.id ? drag.box : boxOf(c)}
  {@const active = selected === c.id}
  <div
    class="c-frame pointer-events-auto absolute rounded-sm border bg-background shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring {active
      ? 'c-frame-active z-10 border-primary ring-2 ring-primary/30'
      : 'border-border hover:border-muted-foreground/60'}"
    style="left: {b.x}px; top: {b.y}px; width: {b.width}px; height: {b.height}px; cursor: {editable &&
    c.anchor.kind !== 'absolute'
      ? 'move'
      : 'default'};"
    role="application"
    tabindex="0"
    aria-label={c.name}
    aria-current={active ? 'true' : undefined}
    data-active={active ? 'true' : undefined}
    onpointerdown={(e) => startMove(e, c)}
    ondblclick={(e) => {
      e.stopPropagation()
      if (editable) onedit(c)
    }}
    onkeydown={(e) => onKeydown(e, c)}
    data-testid="xlsx-chart-frame"
    data-chart-id={c.id}
  >
    <ChartView {wb} {calc} placement={c} width={b.width} height={b.height} {locale} {rev} />
    {#if editable && active}
      <div
        class="c-actions absolute top-1.5 right-1.5 flex items-center gap-1 rounded border border-border bg-background/95 p-0.5 shadow-sm"
        role="toolbar"
        tabindex="-1"
        aria-label={m.drive_sheet_chart_edit()}
        onpointerdown={(e) => e.stopPropagation()}
        ondblclick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          class="c-action-btn inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={m.drive_sheet_chart_edit()}
          title={m.drive_sheet_chart_edit()}
          onclick={() => onedit(c)}
          data-testid="xlsx-chart-edit"><PencilIcon class="size-3.5" aria-hidden="true" /></button
        >
        <button
          type="button"
          class="c-action-btn inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={m.drive_sheet_chart_delete()}
          title={m.drive_sheet_chart_delete()}
          onclick={() => ondelete(c.id)}
          data-testid="xlsx-chart-delete"><Trash2Icon class="size-3.5" aria-hidden="true" /></button
        >
      </div>
      {#if c.anchor.kind !== 'absolute'}
        {#each HANDLES as h (h.dir)}
          <div
            class="c-handle absolute size-2 rounded-xs border border-primary bg-background"
            style="{h.style} cursor: {h.cursor};"
            role="presentation"
            onpointerdown={(e) => startResize(e, c, h.dir)}
            data-testid="xlsx-chart-handle-{h.dir}"
          ></div>
        {/each}
      {/if}
    {/if}
  </div>
{/each}

<style>
  .c-frame {
    position: absolute;
    pointer-events: auto;
    box-sizing: border-box;
    border-radius: 2px;
    border: 1px solid var(--border, #d4d4d8);
    background: var(--background, #ffffff);
    outline: none;
  }

  .c-frame-active {
    z-index: 10;
    border-color: var(--primary, #2563eb);
  }

  .c-actions {
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px;
    border-radius: 4px;
    border: 1px solid var(--border, #d4d4d8);
    background: var(--background, #ffffff);
  }

  .c-action-btn {
    display: inline-flex;
    width: 24px;
    height: 24px;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
  }

  .c-handle {
    position: absolute;
    z-index: 2;
    width: 8px;
    height: 8px;
    box-sizing: border-box;
    border-radius: 2px;
    border: 1px solid var(--primary, #2563eb);
    background: var(--background, #ffffff);
  }
</style>
