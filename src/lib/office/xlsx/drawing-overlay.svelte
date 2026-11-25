<script lang="ts">
  import type { Snippet } from 'svelte'
  import ChartColumnIcon from '@lucide/svelte/icons/chart-column'
  import { m } from '$lib/paraglide/messages.js'
  import { buildGeometry } from '../pptx/geometry'
  import { presetGeometry } from '../pptx/presets'
  import { anchorBox, type AnchoredObject, type Box, type DrawingObject, type Geometry } from './drawing'

  /**
   * Floating drawing layer over the worksheet cells: renders pictures (with
   * crop and rotation), preset shapes, text boxes, connectors, groups, and
   * preserved chart/frame placeholders. Supports click selection, drag to
   * move, 8-handle resize, and double-click inline text editing.
   */
  let {
    objects,
    geometry,
    dx = 0,
    dy = 0,
    mediaUrls,
    selectedId,
    editable,
    onselect,
    onupdate,
    frame,
    onframeopen,
  }: {
    objects: AnchoredObject[]
    geometry: Geometry
    dx?: number
    dy?: number
    mediaUrls: Record<string, string>
    selectedId: string | null
    editable: boolean
    onselect: (id: string | null) => void
    onupdate: (id: string, patch: { box?: Box; text?: string }) => Promise<unknown> | void
    /**
     * Draws a graphic frame (a chart, or other graphicFrame content) in its
     * box: the charts code plugs in here (the object carries `chartPart`).
     * Without it a frame shows as a labelled placeholder; its anchor and
     * parts are never changed by this layer either way.
     */
    frame?: Snippet<[DrawingObject, Box, boolean]>
    /** Double-click on a chart drawn by `frame` (the page opens its editor). */
    onframeopen?: (id: string) => void
  } = $props()

  /** A chart the page draws (`frame`): moved and sized by the same handles as pictures and shapes. */
  const isChart = (o: DrawingObject) => o.kind === 'chart' && !!frame
  /** The chart's id as the charts code names it: its part's file name ("chart1"). */
  const chartIdOf = (o: DrawingObject) =>
    o.chartPart ? o.chartPart.slice(o.chartPart.lastIndexOf('/') + 1).replace(/\.xml$/i, '') : undefined

  const HANDLES = ['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'] as const
  type Handle = (typeof HANDLES)[number]

  /** Where each resize handle sits (layout in real CSS: the layer must work without utility classes). */
  const HANDLE_POS: Record<Handle, string> = {
    nw: 'left: -5px; top: -5px; cursor: nwse-resize;',
    n: 'left: calc(50% - 5px); top: -5px; cursor: ns-resize;',
    ne: 'right: -5px; top: -5px; cursor: nesw-resize;',
    w: 'left: -5px; top: calc(50% - 5px); cursor: ew-resize;',
    e: 'right: -5px; top: calc(50% - 5px); cursor: ew-resize;',
    sw: 'left: -5px; bottom: -5px; cursor: nesw-resize;',
    s: 'left: calc(50% - 5px); bottom: -5px; cursor: ns-resize;',
    se: 'right: -5px; bottom: -5px; cursor: nwse-resize;',
  }

  let draftBox = $state<{ id: string; box: Box } | null>(null)
  let textEdit = $state<{ id: string; value: string } | null>(null)

  function boxOf(o: AnchoredObject): Box | null {
    if (draftBox && draftBox.id === o.id) return draftBox.box
    return o.anchor ? anchorBox(o.anchor, geometry) : null
  }

  function movable(o: AnchoredObject): boolean {
    return (
      editable &&
      o.anchor !== null &&
      (o.kind === 'picture' || o.kind === 'shape' || o.kind === 'textbox' || o.kind === 'connector' || isChart(o))
    )
  }

  function resizeBox(from: Box, h: Handle, mx: number, my: number, minH: number): Box {
    let { x, y, w, h: height } = from
    if (h.includes('w')) {
      const nextW = Math.max(8, w - mx)
      const clampedX = Math.max(0, x + (w - nextW))
      w = w + (x - clampedX)
      x = clampedX
    } else if (h.includes('e')) {
      w = Math.max(8, w + mx)
    }
    if (h.includes('n')) {
      const nextH = Math.max(minH, height - my)
      const clampedY = Math.max(0, y + (height - nextH))
      height = height + (y - clampedY)
      y = clampedY
    } else if (h.includes('s')) {
      height = Math.max(minH, height + my)
    }
    return {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(height),
    }
  }

  function startDrag(e: PointerEvent, o: AnchoredObject, mode: 'move' | Handle) {
    if (e.button !== 0) return
    e.stopPropagation()
    if (o.kind === 'frame' || (o.kind === 'chart' && !isChart(o))) {
      onselect(o.id)
      return
    }
    e.preventDefault()
    onselect(o.id)
    if (!movable(o)) return
    const origin = boxOf(o)
    if (!origin) return
    const sx = e.clientX
    const sy = e.clientY
    const minH = o.geometry === 'line' ? 0 : 8
    let moved = false
    let latest: Box = origin

    const onMove = (ev: PointerEvent) => {
      const mx = ev.clientX - sx
      const my = ev.clientY - sy
      if (!moved && Math.hypot(mx, my) < 2) return
      moved = true
      latest =
        mode === 'move'
          ? {
              x: Math.max(0, Math.round(origin.x + mx)),
              y: Math.max(0, Math.round(origin.y + my)),
              w: origin.w,
              h: origin.h,
            }
          : resizeBox(origin, mode, mx, my, minH)
      draftBox = { id: o.id, box: latest }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      draftBox = null
      if (moved) void onupdate(o.id, { box: latest })
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function beginTextEdit(e: MouseEvent, o: DrawingObject) {
    if (isChart(o)) {
      e.stopPropagation()
      if (editable) onframeopen?.(o.id)
      return
    }
    if (!editable || (o.kind !== 'shape' && o.kind !== 'textbox')) return
    e.stopPropagation()
    onselect(o.id)
    textEdit = { id: o.id, value: o.text ?? '' }
  }

  function commitText(id: string) {
    if (!textEdit || textEdit.id !== id) return
    const val = textEdit.value
    textEdit = null
    void onupdate(id, { text: val })
  }

  function renderShapeSvg(o: DrawingObject, w: number, h: number) {
    const bw = Math.max(1, w)
    const bh = Math.max(1, h)
    const def = presetGeometry(o.geometry || 'rect')
    if (def) return buildGeometry(def, bw, bh, {}, 1)
    return {
      paths: [{ d: `M0 0 L${bw} 0 L${bw} ${bh} L0 ${bh} Z`, fill: 'norm' as const, stroke: true }],
      textRect: { l: 4, t: 4, r: bw - 4, b: bh - 4 },
    }
  }

  function imgCropStyle(crop: DrawingObject['crop']): string {
    if (!crop) return 'width: 100%; height: 100%; object-fit: fill;'
    const vw = Math.max(0.01, 1 - crop.l - crop.r)
    const vh = Math.max(0.01, 1 - crop.t - crop.b)
    return `position: absolute; max-width: none; width: ${(100 / vw).toFixed(3)}%; height: ${(100 / vh).toFixed(3)}%; left: ${((-crop.l / vw) * 100).toFixed(3)}%; top: ${((-crop.t / vh) * 100).toFixed(3)}%;`
  }

  function transformCss(o: DrawingObject): string {
    const parts: string[] = []
    if (o.rotation) parts.push(`rotate(${o.rotation}deg)`)
    if (o.flipH) parts.push('scaleX(-1)')
    if (o.flipV) parts.push('scaleY(-1)')
    return parts.join(' ')
  }
</script>

{#snippet drawingContent(o: DrawingObject, box: Box)}
  {#if o.kind === 'picture'}
    {@const src = o.image?.part ? mediaUrls[o.image.part] : undefined}
    <div class="relative h-full w-full overflow-hidden">
      {#if src}
        <img
          {src}
          alt={o.alt || o.name}
          draggable="false"
          class="select-none"
          style={imgCropStyle(o.crop)}
        />
      {:else}
        <div class="flex h-full w-full items-center justify-center border border-dashed bg-muted/40 text-xs text-muted-foreground">
          {o.name}
        </div>
      {/if}
    </div>
  {:else if o.kind === 'shape' || o.kind === 'textbox' || o.kind === 'connector'}
    {@const svgH = Math.max(1, box.h)}
    {@const built = renderShapeSvg(o, box.w, svgH)}
    {@const strokeColor = o.line ? o.line.color : 'none'}
    {@const strokeW = o.line ? Math.max(1, o.line.widthPx) : 0}
    {@const dash = o.line?.dash ? '5 3' : undefined}
    <svg
      class="pointer-events-none block h-full w-full overflow-visible"
      viewBox="0 0 {Math.max(1, box.w)} {svgH}"
      aria-hidden="true"
    >
      {#if o.line?.arrowEnd || o.line?.arrowStart}
        <defs>
          {#if o.line.arrowEnd}
            <marker
              id="xlsx-arrow-end-{o.id}"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,1 L8,4 L0,7 Z" fill={o.line.color} />
            </marker>
          {/if}
          {#if o.line.arrowStart}
            <marker
              id="xlsx-arrow-start-{o.id}"
              markerWidth="8"
              markerHeight="8"
              refX="1"
              refY="4"
              orient="auto"
            >
              <path d="M8,1 L0,4 L8,7 Z" fill={o.line.color} />
            </marker>
          {/if}
        </defs>
      {/if}
      {#each built.paths as path, idx (idx)}
        <path
          d={path.d}
          fill={path.fill === 'none' || !o.fill ? 'none' : o.fill}
          stroke={path.stroke ? strokeColor : 'none'}
          stroke-width={strokeW}
          stroke-dasharray={dash}
          marker-end={o.line?.arrowEnd ? `url(#xlsx-arrow-end-${o.id})` : undefined}
          marker-start={o.line?.arrowStart ? `url(#xlsx-arrow-start-${o.id})` : undefined}
        />
      {/each}
    </svg>
    {#if o.kind !== 'connector' && o.geometry !== 'line'}
      {#if textEdit && textEdit.id === o.id}
        <textarea
          class="dl-fill resize-none bg-transparent p-1 text-xs outline-none"
          style="color: {o.textColor ?? '#000000'}; text-align: {o.kind === 'textbox' ? 'left' : 'center'};"
          bind:value={textEdit.value}
          onpointerdown={(e) => e.stopPropagation()}
          onkeydown={(e) => {
            e.stopPropagation()
            if (e.key === 'Escape') textEdit = null
            else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) commitText(o.id)
          }}
          onblur={() => commitText(o.id)}
          data-testid="xlsx-shape-inline-text"
        ></textarea>
      {:else if o.text}
        <div
          class="dl-abs dl-ghost flex overflow-hidden p-1 text-xs leading-tight whitespace-pre-wrap {o.kind === 'textbox'
            ? 'items-start justify-start text-left'
            : 'items-center justify-center text-center'}"
          style="left: {built.textRect.l}px; top: {built.textRect.t}px; width: {Math.max(
            0,
            built.textRect.r - built.textRect.l,
          )}px; height: {Math.max(0, built.textRect.b - built.textRect.t)}px; color: {o.textColor ??
            '#000000'};"
        >
          {o.text}
        </div>
      {/if}
    {/if}
  {:else if (o.kind === 'chart' || o.kind === 'frame') && frame}
    {@render frame(o, box, selectedId === o.id)}
  {:else if o.kind === 'chart' || o.kind === 'frame'}
    <div
      class="flex h-full w-full flex-col items-center justify-center gap-1 rounded border border-dashed border-muted-foreground/50 bg-background/85 px-2 text-center text-xs text-muted-foreground"
    >
      <ChartColumnIcon class="size-5 shrink-0" aria-hidden="true" />
      <span class="truncate">{m.drive_sheet_chart_label({ name: o.name })}</span>
    </div>
  {:else if o.kind === 'group' && o.children}
    {#each o.children as child (child.id)}
      <div
        class="dl-abs dl-ghost"
        style="left: {child.box.x - box.x}px; top: {child.box.y - box.y}px; width: {child.box.w}px; height: {Math.max(
          2,
          child.box.h,
        )}px; transform: {transformCss(child)};"
      >
        {@render drawingContent(child, child.box)}
      </div>
    {/each}
  {/if}
{/snippet}

<div class="dl-layer" data-testid="xlsx-drawing-layer">
  {#each objects as o (o.id)}
    {#if !o.hidden}
      {@const box = boxOf(o)}
      {#if box}
        {@const sel = selectedId === o.id}
        <div
          role="button"
          tabindex="-1"
          aria-label={o.alt ? `${o.name}: ${o.alt}` : o.name}
          class="dl-item select-none {sel
            ? 'ring-2 ring-primary'
            : 'hover:ring-1 hover:ring-primary/50'}"
          style="left: {box.x - dx}px; top: {box.y - dy}px; width: {box.w}px; height: {Math.max(
            8,
            box.h,
          )}px; transform: {transformCss(o)};"
          data-testid={isChart(o) ? 'xlsx-chart-frame' : 'xlsx-drawing-item'}
          data-chart-id={isChart(o) ? chartIdOf(o) : undefined}
          data-drawing-id={o.id}
          data-drawing-kind={o.kind}
          onpointerdown={(e) => startDrag(e, o, 'move')}
          ondblclick={(e) => beginTextEdit(e, o)}
        >
          {@render drawingContent(o, box)}
          {#if sel && movable(o)}
            {#each HANDLES as h (h)}
              <button
                type="button"
                tabindex="-1"
                aria-label={m.drive_sheet_drawing_resize({ handle: h })}
                class="dl-handle rounded-full border border-primary bg-background"
                style={HANDLE_POS[h]}
                data-testid={isChart(o) ? `xlsx-chart-handle-${h}` : `xlsx-drawing-handle-${h}`}
                onpointerdown={(e) => startDrag(e, o, h)}
              ></button>
            {/each}
          {/if}
        </div>
      {/if}
    {/if}
  {/each}
</div>

<style>
  /* Layout the layer needs to work at all (positions, hit-testing), kept here rather than in utility classes. */
  .dl-layer {
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;
  }
  .dl-item {
    position: absolute;
    box-sizing: border-box;
    pointer-events: auto;
  }
  .dl-abs {
    position: absolute;
  }
  .dl-ghost {
    pointer-events: none;
  }
  .dl-fill {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .dl-handle {
    position: absolute;
    z-index: 10;
    width: 10px;
    height: 10px;
    padding: 0;
  }
</style>
