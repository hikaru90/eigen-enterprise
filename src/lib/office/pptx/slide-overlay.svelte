<script lang="ts">
  import { HANDLES, moveFrame, resizeFrame, rotationTo, type EditFrame, type Handle } from './edit-geometry'

  /**
   * The editing layer over the current slide (S2): one hit area per shape of
   * the slide (in z-order), the selection box with resize handles (Shift
   * keeps the aspect) and a rotate handle (Shift snaps to 15°), and dragging
   * to move. While a drag runs, the drawn shapes move with it (a transform on
   * their `data-sid` group); on release `oncommit` gets the new frames.
   * Coordinates are the slide's own (CSS px of the viewBox).
   */
  export type OverlayItem = {
    id: string
    name: string
    frame: EditFrame
    /** Has a text box to type into (double-click). */
    text: boolean
    /** An empty placeholder: drawn as a dashed outline so it can be found. */
    empty: boolean
    resizable: boolean
    rotatable: boolean
  }
  export type FrameChange = { id: string; from: EditFrame; to: EditFrame }

  let {
    width,
    height,
    items,
    selected,
    typing,
    target,
    onselect,
    oncommit,
    onedittext,
  }: {
    width: number
    height: number
    items: OverlayItem[]
    selected: string[]
    /** The shape whose text is being typed into: the layer lets the pointer through. */
    typing: string | null
    /** The drawn shape for an id (moved live while dragging). */
    target: (id: string) => Element | null
    onselect: (ids: string[]) => void
    oncommit: (changes: FrameChange[]) => Promise<unknown>
    onedittext: (id: string) => void
  } = $props()

  let svgEl = $state<SVGSVGElement | null>(null)
  let clientWidth = $state(1)
  /** Live frames while dragging. */
  let drafts = $state<Record<string, EditFrame>>({})

  /** Slide px per screen px: handles keep their size on screen. */
  const k = $derived(width / Math.max(1, clientWidth))
  const single = $derived(selected.length === 1 ? (items.find((i) => i.id === selected[0]) ?? null) : null)
  const frameOf = (item: OverlayItem) => drafts[item.id] ?? item.frame

  function toSlide(e: PointerEvent | MouseEvent): { x: number; y: number } {
    const m = svgEl?.getScreenCTM()
    if (!m) return { x: 0, y: 0 }
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return { x: pt.x, y: pt.y }
  }

  const n = (v: number) => Math.round(v * 1000) / 1000

  /** The transform that carries a drawn shape from frame `a` to frame `b`. */
  function carry(a: EditFrame, b: EditFrame): string {
    const sx = a.w ? b.w / a.w : 1
    const sy = a.h ? b.h / a.h : 1
    return `translate(${n(b.x + b.w / 2)} ${n(b.y + b.h / 2)}) rotate(${n(b.rot)}) scale(${n(sx)} ${n(sy)}) rotate(${n(-a.rot)}) translate(${n(-(a.x + a.w / 2))} ${n(-(a.y + a.h / 2))})`
  }

  type Drag = { kind: 'move' | Handle | 'rotate'; start: { x: number; y: number }; screen: { x: number; y: number }; from: Record<string, EditFrame>; moved: boolean }

  function begin(e: PointerEvent, kind: Drag['kind'], ids: string[]) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const from: Record<string, EditFrame> = {}
    for (const id of ids) {
      const item = items.find((i) => i.id === id)
      if (item) from[id] = item.frame
    }
    const drag: Drag = { kind, start: toSlide(e), screen: { x: e.clientX, y: e.clientY }, from, moved: false }
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the drawn shapes' own transforms while a drag runs, restored on release; never rendered
    const originals = new Map<Element, string | null>()
    const onMove = (ev: PointerEvent) => {
      if (!drag.moved && Math.hypot(ev.clientX - drag.screen.x, ev.clientY - drag.screen.y) < 3) return
      drag.moved = true
      const p = toSlide(ev)
      const dx = p.x - drag.start.x
      const dy = p.y - drag.start.y
      const next: Record<string, EditFrame> = {}
      for (const [id, f] of Object.entries(drag.from)) {
        next[id] = drag.kind === 'move' ? moveFrame(f, dx, dy) : drag.kind === 'rotate' ? { ...f, rot: rotationTo(f, p.x, p.y, ev.shiftKey) } : resizeFrame(f, drag.kind, dx, dy, ev.shiftKey)
        const el = target(id)
        if (el) {
          if (!originals.has(el)) originals.set(el, el.getAttribute('transform'))
          el.setAttribute('transform', `${carry(f, next[id]!)} ${originals.get(el) ?? ''}`.trim())
        }
      }
      drafts = next
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      const done = drafts
      const restore = () => {
        for (const [el, t] of originals) {
          if (t === null) el.removeAttribute('transform')
          else el.setAttribute('transform', t)
        }
        drafts = {}
      }
      if (!drag.moved) return restore()
      const changes = Object.entries(done).map(([id, to]) => ({ id, from: drag.from[id]!, to }))
      void oncommit(changes).finally(restore)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function onItemDown(e: PointerEvent, item: OverlayItem) {
    if (e.button !== 0) return
    if (e.shiftKey) {
      e.preventDefault()
      onselect(selected.includes(item.id) ? selected.filter((s) => s !== item.id) : [...selected, item.id])
      return
    }
    const ids = selected.includes(item.id) ? selected : [item.id]
    if (!selected.includes(item.id)) onselect(ids)
    begin(e, 'move', ids)
  }

  function onBackgroundDown(e: PointerEvent) {
    if (e.button !== 0 || e.shiftKey) return
    onselect([])
  }

  const HANDLE_CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }
</script>

<div class="absolute inset-0" bind:clientWidth data-testid="pptx-overlay" data-typing={typing ?? undefined}>
  <svg
    bind:this={svgEl}
    viewBox={`0 0 ${width} ${height}`}
    preserveAspectRatio="xMidYMid meet"
    class="block h-full w-full"
    style={`pointer-events:${typing ? 'none' : 'auto'};touch-action:none`}
    role="presentation"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <rect x="0" y="0" {width} {height} fill="transparent" onpointerdown={onBackgroundDown} data-testid="pptx-overlay-background" />
    {#each items as item (item.id)}
      {@const f = frameOf(item)}
      <g transform={`rotate(${f.rot} ${f.x + f.w / 2} ${f.y + f.h / 2})`}>
        {#if item.empty && !selected.includes(item.id)}
          <rect x={f.x} y={f.y} width={f.w} height={f.h} fill="none" stroke="#9ca3af" stroke-dasharray="4 3" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none" />
        {/if}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <rect
          x={f.x}
          y={f.y}
          width={Math.max(f.w, 4 * k)}
          height={Math.max(f.h, 4 * k)}
          fill="transparent"
          style={`cursor:${typing === item.id ? 'text' : 'move'}`}
          onpointerdown={(e) => onItemDown(e, item)}
          ondblclick={() => item.text && onedittext(item.id)}
          data-hit={item.id}
          data-testid="pptx-hit"
          aria-label={item.name}
        />
        {#if selected.includes(item.id)}
          <rect x={f.x} y={f.y} width={f.w} height={f.h} fill="none" stroke="#2563eb" stroke-width="1.5" vector-effect="non-scaling-stroke" pointer-events="none" data-testid="pptx-selection" data-id={item.id} />
        {/if}
      </g>
    {/each}
    {#if single && typing !== single.id}
      {@const f = frameOf(single)}
      {@const hs = 8 * k}
      <g transform={`rotate(${f.rot} ${f.x + f.w / 2} ${f.y + f.h / 2})`}>
        {#if single.rotatable}
          <line x1={f.x + f.w / 2} y1={f.y} x2={f.x + f.w / 2} y2={f.y - 22 * k} stroke="#2563eb" stroke-width="1" vector-effect="non-scaling-stroke" pointer-events="none" />
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <circle
            cx={f.x + f.w / 2}
            cy={f.y - 22 * k}
            r={5 * k}
            fill="#fff"
            stroke="#2563eb"
            stroke-width="1.5"
            vector-effect="non-scaling-stroke"
            style="cursor:grab"
            onpointerdown={(e) => begin(e, 'rotate', [single.id])}
            data-testid="pptx-rotate-handle"
          />
        {/if}
        {#if single.resizable}
          {#each Object.entries(HANDLES) as [h, [hx, hy]] (h)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect
              x={f.x + ((hx + 1) / 2) * f.w - hs / 2}
              y={f.y + ((hy + 1) / 2) * f.h - hs / 2}
              width={hs}
              height={hs}
              fill="#fff"
              stroke="#2563eb"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
              style={`cursor:${HANDLE_CURSOR[h as Handle]}`}
              onpointerdown={(e) => begin(e, h as Handle, [single.id])}
              data-handle={h}
              data-testid="pptx-handle"
            />
          {/each}
        {/if}
      </g>
    {/if}
  </svg>
</div>
