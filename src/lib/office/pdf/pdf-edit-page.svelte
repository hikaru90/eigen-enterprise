<script lang="ts" module>
  import type { AnnotationKind } from './annotate-model'

  /** What a pointer on the page does: select/move, or make one kind of annotation. */
  export type EditTool = 'select' | AnnotationKind
  export const MARKUP_TOOLS: readonly EditTool[] = [
    'Highlight',
    'Underline',
    'StrikeOut',
    'Squiggly',
  ]
</script>

<script lang="ts">
  import type { FieldValue, PdfFormField } from './forms'
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import {
    appearanceOf,
    kindLabel,
    moveShape,
    normRect,
    quadOf,
    type AnnotationShape,
    type Measure,
    type NewAnnotation,
    type PdfAnnotation,
    type Rect,
    type Rgb,
  } from './annotate-model'
  import { linesOf, svgOf } from './annotate-svg'
  import { canvasPixelRatio, CSS_PER_POINT } from './layout'
  import { type PdfJs, type PdfPage } from './pdfjs'

  /**
   * One page in the PDF editor (Annotate and Fill form, P3): the page drawn
   * without its annotations, the annotations drawn over it from the staged
   * model (./annotate-svg.ts — the same geometry the file's appearance
   * streams are written from), a text layer to select text for markups, and
   * the form's fields as real inputs where the file puts them.
   */
  let {
    lib,
    page,
    index,
    scale,
    mode,
    tool,
    color,
    opacity,
    strokeWidth,
    annotations,
    selected,
    fields,
    values,
    canStage,
    measure,
    onadd,
    onselect,
    onmove,
    onfield,
    onerror,
  }: {
    lib: PdfJs
    page: PdfPage
    index: number
    /** CSS pixels per point. */
    scale: number
    mode: 'annotate' | 'form'
    tool: EditTool
    color: Rgb
    opacity: number
    strokeWidth: number
    annotations: PdfAnnotation[]
    selected: string | null
    fields: PdfFormField[]
    values: Record<string, FieldValue>
    canStage: boolean
    measure: Measure
    onadd: (a: NewAnnotation) => void
    onselect: (id: string | null) => void
    onmove: (id: string, dx: number, dy: number) => void
    onfield: (name: string, value: FieldValue) => void
    onerror: (message: string) => void
  } = $props()

  const viewport = $derived(page.getViewport({ scale }))
  const matrix = $derived(viewport.transform.join(' '))
  const drawing = $derived(
    mode === 'annotate' && canStage && tool !== 'select' && !MARKUP_TOOLS.includes(tool),
  )

  let host: HTMLDivElement
  let surface: HTMLDivElement | null = $state(null)
  let drawnAt = 0
  let visible = false
  let destroyed = false
  let textReady = false
  /** A gesture in progress: points in PDF space. */
  let gesture = $state.raw<{ points: number[] } | null>(null)
  /** A note or text box waiting for its text. */
  let draft = $state.raw<{ shape: AnnotationShape } | null>(null)
  let draftText = $state('')
  /** Moving the selection: the offset so far, PDF space. */
  let drag = $state.raw<{ id: string; from: [number, number]; dx: number; dy: number } | null>(null)

  onMount(() => {
    const seen = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting)
        if (visible) void draw()
      },
      { rootMargin: '400px 0px' },
    )
    seen.observe(host)
    return () => {
      destroyed = true
      seen.disconnect()
    }
  })

  /** Draws the page (no annotations: they are drawn from the model) and lays out its text once. */
  async function draw() {
    const at = scale * window.devicePixelRatio
    if (drawnAt === at || destroyed) return
    drawnAt = at
    const vp = page.getViewport({ scale })
    const ratio = canvasPixelRatio(vp.width, vp.height, window.devicePixelRatio)
    const canvas = document.createElement('canvas')
    canvas.className = 'pdf-edit-canvas'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.width = Math.floor(vp.width * ratio)
    canvas.height = Math.floor(vp.height * ratio)
    try {
      await page.render({
        canvas,
        viewport: vp,
        annotationMode: lib.AnnotationMode.DISABLE,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      }).promise
    } catch (err) {
      drawnAt = 0
      onerror(`Page ${index + 1} could not be drawn: ${messageOf(err)}`)
      return
    }
    if (destroyed) return
    host.querySelector('.pdf-edit-canvas')?.remove()
    host.prepend(canvas)
    host.dataset.drawn = 'true'
    if (!textReady) {
      textReady = true
      const div = document.createElement('div')
      div.className = 'textLayer'
      host.querySelector('.pdf-edit-text')?.append(div)
      try {
        await new lib.TextLayer({
          textContentSource: await page.getTextContent(),
          container: div,
          viewport: page.getViewport({ scale: CSS_PER_POINT }),
        }).render()
      } catch (err) {
        onerror(`The text of page ${index + 1} could not be laid out: ${messageOf(err)}`)
      }
    }
  }

  /** Redraws after a zoom change, if on screen (the parent calls this). */
  export function refresh() {
    if (visible) void draw()
  }

  function messageOf(err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }

  function toPdf(event: PointerEvent | MouseEvent): [number, number] {
    const r = host.getBoundingClientRect()
    const [x, y] = viewport.convertToPdfPoint(event.clientX - r.left, event.clientY - r.top)
    return [x!, y!]
  }

  function boxOf(points: number[]): Rect {
    const [x1, y1] = [points[0]!, points[1]!]
    const [x2, y2] = [points.at(-2)!, points.at(-1)!]
    return normRect([x1, y1, x2, y2])
  }

  // --- drawing ---------------------------------------------------------------

  function onSurfaceDown(event: PointerEvent) {
    if (!drawing || draft) return
    event.preventDefault()
    surface?.setPointerCapture(event.pointerId)
    const p = toPdf(event)
    if (tool === 'Text') {
      draft = { shape: { kind: 'Text', at: p } }
      draftText = ''
      return
    }
    gesture = { points: [...p] }
  }

  function onSurfaceMove(event: PointerEvent) {
    if (!gesture) return
    const p = toPdf(event)
    gesture =
      tool === 'Ink'
        ? { points: [...gesture.points, ...p] }
        : { points: [gesture.points[0]!, gesture.points[1]!, ...p] }
  }

  function onSurfaceUp() {
    const g = gesture
    gesture = null
    if (!g) return
    const shape = shapeFrom(g.points)
    if (!shape) return
    if (shape.kind === 'FreeText') {
      draft = { shape }
      draftText = ''
      return
    }
    onadd({ page: index, shape, color, opacity })
  }

  /** The shape a finished gesture makes (null: too small to mean anything). */
  function shapeFrom(points: number[]): AnnotationShape | null {
    if (tool === 'Ink')
      return points.length >= 4 ? { kind: 'Ink', paths: [points], width: strokeWidth } : null
    const box = boxOf(points)
    const big = box[2] - box[0] > 3 || box[3] - box[1] > 3
    if (!big)
      return tool === 'FreeText'
        ? { kind: 'FreeText', rect: [box[0], box[1] - 40, box[0] + 180, box[1]], fontSize: 12 }
        : null
    switch (tool) {
      case 'FreeText':
        return { kind: 'FreeText', rect: box, fontSize: 12 }
      case 'Square':
      case 'Circle':
        return { kind: tool, rect: box, width: strokeWidth, fill: null }
      case 'Line':
        return {
          kind: 'Line',
          line: [points[0]!, points[1]!, points.at(-2)!, points.at(-1)!],
          width: strokeWidth,
          ends: ['None', 'OpenArrow'],
        }
      default:
        return null
    }
  }

  function addDraft() {
    if (!draft || !draftText.trim()) return
    onadd({ page: index, shape: draft.shape, color, opacity, contents: draftText })
    draft = null
    draftText = ''
  }

  /** The preview of the gesture in progress. */
  const preview = $derived.by(() => {
    if (!gesture) return null
    const shape = shapeFrom(gesture.points)
    return shape ? svgOf(appearanceOf(shape, color, '', measure)) : null
  })

  // --- text markups --------------------------------------------------------------

  function onTextUp() {
    if (mode !== 'annotate' || !canStage || !MARKUP_TOOLS.includes(tool)) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
    const r = host.getBoundingClientRect()
    const boxes: Array<[number, number, number, number]> = []
    for (let i = 0; i < selection.rangeCount; i++) {
      for (const c of selection.getRangeAt(i).getClientRects()) {
        if (c.right < r.left || c.left > r.right || c.bottom < r.top || c.top > r.bottom) continue
        const [x1, y1, x2, y2] = viewport
          .convertToPdfPoint(c.left - r.left, c.bottom - r.top)
          .concat(viewport.convertToPdfPoint(c.right - r.left, c.top - r.top))
        boxes.push(normRect([x1!, y1!, x2!, y2!]))
      }
    }
    selection.removeAllRanges()
    const lines = linesOf(boxes)
    if (lines.length === 0) return
    onadd({
      page: index,
      shape: { kind: tool as 'Highlight', quads: lines.map((b) => quadOf(b)) },
      color,
      opacity,
    })
  }

  // --- select and move ---------------------------------------------------------

  function onHitDown(event: PointerEvent, a: PdfAnnotation) {
    if (mode !== 'annotate' || tool !== 'select') return
    event.preventDefault()
    event.stopPropagation()
    onselect(a.id)
    if (!canStage) return
    ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
    drag = { id: a.id, from: toPdf(event), dx: 0, dy: 0 }
  }

  function onHitMove(event: PointerEvent) {
    if (!drag) return
    const [x, y] = toPdf(event)
    drag = { ...drag, dx: x - drag.from[0], dy: y - drag.from[1] }
  }

  function onHitUp() {
    const d = drag
    drag = null
    if (d && Math.hypot(d.dx, d.dy) >= 1) onmove(d.id, d.dx, d.dy)
  }

  function onHitKey(event: KeyboardEvent, a: PdfAnnotation) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onselect(a.id)
    }
  }

  /** What each annotation draws, moved along while dragged. */
  const drawn = $derived(
    annotations.map((a) => {
      const moving = drag && drag.id === a.id ? drag : null
      const shape = a.shape && moving ? moveShape(a.shape, moving.dx, moving.dy) : a.shape
      const rect: Rect = moving
        ? [
            a.rect[0] + moving.dx,
            a.rect[1] + moving.dy,
            a.rect[2] + moving.dx,
            a.rect[3] + moving.dy,
          ]
        : a.rect
      return {
        a,
        rect,
        prims: shape && a.color ? svgOf(appearanceOf(shape, a.color, a.contents, measure)) : [],
      }
    }),
  )

  // --- form fields -----------------------------------------------------------------

  function placeOf(rect: Rect) {
    const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]) as [number, number]
    const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]) as [number, number]
    return {
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
    }
  }

  const widgets = $derived(
    fields.flatMap((field) =>
      field.widgets
        .filter((w) => w.page === index)
        .map((w, k) => ({ field, widget: w, key: `${field.name}#${k}`, place: placeOf(w.rect) })),
    ),
  )

  const valueOf = (f: PdfFormField): PdfFormField['value'] =>
    f.name in values ? values[f.name]! : f.value
  const fieldsLive = $derived(mode === 'form' && canStage)
  const listValue = (f: PdfFormField) => {
    const v = valueOf(f)
    return Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []
  }
</script>

<div
  bind:this={host}
  class="pdf-edit-page"
  class:markup={mode === 'annotate' && MARKUP_TOOLS.includes(tool) && canStage}
  style:width={`${Math.floor(viewport.width)}px`}
  style:height={`${Math.floor(viewport.height)}px`}
  style:--total-scale-factor={scale}
  role="group"
  aria-label={`Page ${index + 1}`}
  data-testid="pdf-edit-page"
  data-page={index}
>
  <div class="pdf-edit-text" role="presentation" onpointerup={onTextUp}></div>

  <svg
    class="pdf-edit-svg"
    width={viewport.width}
    height={viewport.height}
    aria-hidden="true"
    data-testid="pdf-edit-annotations"
  >
    <g transform={`matrix(${matrix})`}>
      {#each drawn as d (d.a.id)}
        <g
          opacity={d.a.opacity}
          data-annotation={d.a.id}
          data-kind={d.a.kind}
          class:selected={d.a.id === selected}
        >
          {#each d.prims as p, k (k)}
            {#if p.kind === 'path'}
              <path
                d={p.d}
                fill={p.fill}
                stroke={p.stroke}
                stroke-width={p.width}
                stroke-linecap={p.round ? 'round' : 'butt'}
                stroke-linejoin={p.round ? 'round' : 'miter'}
                style:mix-blend-mode={p.multiply ? 'multiply' : undefined}
              />
            {:else}
              <text
                transform={`translate(${p.x} ${p.y}) scale(1 -1)`}
                font-family="Helvetica, Arial, sans-serif"
                font-size={p.size}
                fill={p.fill}
              >
                {#each p.lines as line, i (i)}<tspan x="0" dy={i === 0 ? 0 : p.size * 1.2}
                    >{line}</tspan
                  >{/each}
              </text>
            {/if}
          {/each}
          {#if d.a.kind === 'Other'}
            <rect
              x={d.rect[0]}
              y={d.rect[1]}
              width={d.rect[2] - d.rect[0]}
              height={d.rect[3] - d.rect[1]}
              fill="none"
              stroke="#64748b"
              stroke-dasharray="3 2"
              stroke-width={1 / scale}
            />
          {/if}
          {#if d.a.id === selected}
            <rect
              class="pdf-edit-selection"
              x={d.rect[0] - 2}
              y={d.rect[1] - 2}
              width={d.rect[2] - d.rect[0] + 4}
              height={d.rect[3] - d.rect[1] + 4}
              fill="none"
              stroke="#2563eb"
              stroke-width={1.5 / scale}
              stroke-dasharray={`${4 / scale} ${2 / scale}`}
            />
          {/if}
        </g>
      {/each}
      {#if preview}
        <g {opacity} data-testid="pdf-edit-preview">
          {#each preview as p, k (k)}
            {#if p.kind === 'path'}
              <path d={p.d} fill={p.fill} stroke={p.stroke} stroke-width={p.width} />
            {/if}
          {/each}
        </g>
      {/if}
    </g>
  </svg>

  {#if mode === 'annotate' && tool === 'select'}
    {#each drawn as d (d.a.id)}
      {@const place = placeOf(d.rect)}
      <div
        class="pdf-edit-hit"
        style:left={`${place.left}px`}
        style:top={`${place.top}px`}
        style:width={`${Math.max(8, place.width)}px`}
        style:height={`${Math.max(8, place.height)}px`}
        role="button"
        tabindex="0"
        aria-label={`${kindLabel(d.a.kind)}${d.a.author ? ` by ${d.a.author}` : ''}`}
        aria-pressed={d.a.id === selected}
        data-testid="pdf-edit-hit"
        data-annotation={d.a.id}
        onpointerdown={(e) => onHitDown(e, d.a)}
        onpointermove={onHitMove}
        onpointerup={onHitUp}
        onpointercancel={() => (drag = null)}
        onkeydown={(e) => onHitKey(e, d.a)}
      ></div>
    {/each}
  {/if}

  {#if drawing}
    <div
      bind:this={surface}
      class="pdf-edit-surface"
      role="application"
      aria-label={`Draw a ${kindLabel(tool as AnnotationKind).toLowerCase()} on page ${index + 1}`}
      data-testid="pdf-edit-surface"
      onpointerdown={onSurfaceDown}
      onpointermove={onSurfaceMove}
      onpointerup={onSurfaceUp}
      onpointercancel={() => (gesture = null)}
    ></div>
  {/if}

  {#each widgets as w (w.key)}
    {@const f = w.field}
    {@const disabled = !fieldsLive || f.readOnly}
    <div
      class="pdf-edit-field"
      class:live={fieldsLive}
      style:left={`${w.place.left}px`}
      style:top={`${w.place.top}px`}
      style:width={`${w.place.width}px`}
      style:height={`${w.place.height}px`}
      data-testid="pdf-field"
      data-field={f.name}
    >
      {#if f.type === 'text'}
        {#if f.multiline}
          <textarea
            aria-label={f.name}
            value={valueOf(f) as string}
            maxlength={f.maxLength ?? undefined}
            required={f.required}
            readonly={f.readOnly}
            {disabled}
            oninput={(e) => onfield(f.name, e.currentTarget.value)}></textarea>
        {:else}
          <input
            type="text"
            aria-label={f.name}
            value={valueOf(f) as string}
            maxlength={f.maxLength ?? undefined}
            required={f.required}
            readonly={f.readOnly}
            {disabled}
            oninput={(e) => onfield(f.name, e.currentTarget.value)}
          />
        {/if}
      {:else if f.type === 'checkbox'}
        <input
          type="checkbox"
          aria-label={f.name}
          checked={valueOf(f) === true}
          {disabled}
          onchange={(e) => onfield(f.name, e.currentTarget.checked)}
        />
      {:else if f.type === 'radio'}
        <input
          type="radio"
          name={`pdf-radio-${f.name}`}
          aria-label={`${f.name}: ${w.widget.option ?? ''}`}
          checked={valueOf(f) === w.widget.option}
          {disabled}
          onchange={() => onfield(f.name, w.widget.option ?? '')}
        />
      {:else if f.type === 'dropdown' && !f.multiselect}
        <select
          aria-label={f.name}
          value={listValue(f)[0] ?? ''}
          {disabled}
          onchange={(e) => onfield(f.name, e.currentTarget.value)}
        >
          <option value="">—</option>
          {#each f.options as o (o)}<option value={o}>{o}</option>{/each}
        </select>
      {:else if f.type === 'dropdown' || f.type === 'listbox'}
        <select
          aria-label={f.name}
          multiple={f.multiselect}
          size={Math.max(2, Math.min(f.options.length, 6))}
          {disabled}
          onchange={(e) =>
            onfield(
              f.name,
              [...e.currentTarget.selectedOptions].map((o) => o.value),
            )}
        >
          {#each f.options as o (o)}<option value={o} selected={listValue(f).includes(o)}
              >{o}</option
            >{/each}
        </select>
      {:else if f.type === 'signature'}
        <span class="pdf-edit-sig" title="Signature fields are shown, not signed, here"
          >{f.signed ? 'Signed' : 'Signature (not signed)'}</span
        >
      {:else}
        <span class="pdf-edit-sig">{f.name}</span>
      {/if}
    </div>
  {/each}

  {#if draft}
    {@const place = placeOf(
      draft.shape.kind === 'Text'
        ? [draft.shape.at[0], draft.shape.at[1] - 20, draft.shape.at[0] + 20, draft.shape.at[1]]
        : draft.shape.kind === 'FreeText'
          ? draft.shape.rect
          : [0, 0, 0, 0],
    )}
    <form
      class="pdf-edit-draft rounded-md border bg-card p-2 shadow-md"
      style:left={`${Math.min(place.left, viewport.width - 240)}px`}
      style:top={`${place.top + place.height + 4}px`}
      data-testid="pdf-edit-draft"
      onsubmit={(e) => {
        e.preventDefault()
        addDraft()
      }}
    >
      <textarea
        class="h-20 w-56 rounded border bg-background p-1 text-sm"
        aria-label={draft.shape.kind === 'Text' ? 'Note text' : 'Text box text'}
        placeholder={draft.shape.kind === 'Text' ? 'Write a note…' : 'Text for the box…'}
        bind:value={draftText}
        {@attach (el: HTMLTextAreaElement) => el.focus()}
        onkeydown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            addDraft()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            draft = null
          }
        }}></textarea>
      <div class="mt-1 flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" onclick={() => (draft = null)}
          >Cancel</Button
        >
        <Button
          type="submit"
          size="sm"
          disabled={!draftText.trim()}
          data-testid="pdf-edit-draft-add">Add</Button
        >
      </div>
    </form>
  {/if}
</div>

<style>
  .pdf-edit-page {
    position: relative;
    margin: 0 auto;
    background: white;
    box-shadow:
      0 0 0 1px rgb(0 0 0 / 0.08),
      0 1px 3px rgb(0 0 0 / 0.12);
    overflow: hidden;
    --scale-round-x: 1px;
    --scale-round-y: 1px;
  }
  .pdf-edit-page :global(.pdf-edit-canvas) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .pdf-edit-svg {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: visible;
  }
  .pdf-edit-text {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .markup .pdf-edit-text {
    pointer-events: auto;
  }
  .pdf-edit-hit {
    position: absolute;
    cursor: move;
    outline: none;
  }
  .pdf-edit-hit:focus-visible {
    box-shadow: 0 0 0 2px var(--ring, #2563eb);
  }
  .pdf-edit-surface {
    position: absolute;
    inset: 0;
    cursor: crosshair;
    touch-action: none;
  }
  .pdf-edit-field {
    position: absolute;
    display: flex;
  }
  .pdf-edit-field > :global(input[type='text']),
  .pdf-edit-field > :global(textarea),
  .pdf-edit-field > :global(select) {
    width: 100%;
    height: 100%;
    font-size: 13px;
    padding: 0 2px;
    border: 1px solid rgb(37 99 235 / 0.35);
    background: rgb(219 234 254 / 0.55);
    color: black;
  }
  .pdf-edit-field > :global(:disabled) {
    background: rgb(241 245 249 / 0.6);
    border-color: rgb(148 163 184 / 0.4);
  }
  .pdf-edit-field > :global(input[type='checkbox']),
  .pdf-edit-field > :global(input[type='radio']) {
    width: 100%;
    height: 100%;
    margin: 0;
  }
  .pdf-edit-sig {
    width: 100%;
    font-size: 13px;
    color: #475569;
    border: 1px dashed #94a3b8;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .pdf-edit-draft {
    position: absolute;
    z-index: 5;
  }
  /* The text layer (as in the viewer; adapted from pdf.js's stylesheet, Apache-2.0). */
  .pdf-edit-page :global(.textLayer) {
    position: absolute;
    inset: 0;
    overflow: clip;
    line-height: 1;
    transform-origin: 0 0;
    --min-font-size: 1;
    --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
    --min-font-size-inv: calc(1 / var(--min-font-size));
  }
  .pdf-edit-page :global(.textLayer :is(span, br)) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
  }
  .pdf-edit-page :global(.textLayer > :not(.markedContent)),
  .pdf-edit-page :global(.textLayer .markedContent span:not(.markedContent)) {
    --font-height: 0;
    font-size: calc(var(--text-scale-factor) * var(--font-height));
    --scale-x: 1;
    --rotate: 0deg;
    transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
  }
  .pdf-edit-page :global(.textLayer .markedContent) {
    display: contents;
  }
  .pdf-edit-page :global(.textLayer ::selection) {
    background: color-mix(in srgb, AccentColor, transparent 50%);
  }
</style>
