<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import {
    clampView,
    cropOf,
    fitView,
    scaleRange,
    viewOf,
    zoomAround,
    type CropView,
    type ImageSize,
    type LogoCrop,
  } from '$lib/company/logo-crop'
  import { Button } from '$lib/components/ui/button'

  /**
   * Zoom and position the company logo in a square frame before it is saved
   * (Contribute `8c371cea`). Drag to move it; zoom with the slider, the mouse
   * wheel or trackpad, a pinch, or + / − (arrow keys move it). The ring shows
   * the round badge at the top left of the app; beside the frame, the result
   * at the sizes the app shows it. Saving hands back the crop (the frame in
   * the image's own pixels) — the server cuts the logo from the original.
   */
  let {
    src,
    crop: initialCrop,
    busy = false,
    onsave,
    oncancel,
  }: {
    src: string
    /** Where a re-crop starts (the stored crop); a new image starts fitted. */
    crop?: LogoCrop
    busy?: boolean
    onsave: (crop: LogoCrop) => void
    oncancel: () => void
  } = $props()

  /** The frame's size in CSS pixels. */
  const FRAME = 240
  /** Slider steps between the whole image and the closest zoom. */
  const STEPS = 100
  const KEY_MOVE = 8
  const KEY_ZOOM = 1.1

  let size = $state<ImageSize | null>(null)
  let view = $state<CropView>({ scale: 1, x: 0, y: 0 })
  let frameEl: HTMLDivElement | undefined = $state()
  let loadError = $state(false)

  const range = $derived(size ? scaleRange(size, FRAME) : null)
  /** The slider is logarithmic: each step zooms by the same factor. */
  const step = $derived(
    range && range.max > range.min
      ? Math.round((STEPS * Math.log(view.scale / range.min)) / Math.log(range.max / range.min))
      : 0,
  )
  const imageStyle = (s: ImageSize, v: CropView, factor: number) =>
    `width:${s.width * v.scale * factor}px;height:${s.height * v.scale * factor}px;transform:translate(${v.x * factor}px,${v.y * factor}px)`

  function onLoad(event: Event) {
    const img = event.currentTarget as HTMLImageElement
    size = { width: img.naturalWidth, height: img.naturalHeight }
    view = initialCrop ? viewOf(initialCrop, size, FRAME) : fitView(size, FRAME)
  }

  const centre = { x: FRAME / 2, y: FRAME / 2 }

  function zoomTo(scale: number, at: { x: number; y: number } = centre) {
    if (size) view = zoomAround(view, scale, at, size, FRAME)
  }

  function moveBy(dx: number, dy: number) {
    if (size) view = clampView({ ...view, x: view.x + dx, y: view.y + dy }, size, FRAME)
  }

  function onSlider(event: Event & { currentTarget: HTMLInputElement }) {
    if (!range) return
    const t = Number(event.currentTarget.value) / STEPS
    zoomTo(range.min * Math.pow(range.max / range.min, t))
  }

  /** Frame pixels of a pointer or wheel event. */
  function inFrame(event: { clientX: number; clientY: number }) {
    const box = frameEl!.getBoundingClientRect()
    return { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  // Pointers on the frame: one drags, two pinch (zoom around their midpoint).
  const pointers = new SvelteMap<number, { x: number; y: number }>()
  let pinch: { distance: number; scale: number } | null = null

  const distanceOf = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y)

  function onPointerDown(event: PointerEvent) {
    if (!size || busy) return
    event.preventDefault()
    frameEl?.focus()
    pointers.set(event.pointerId, inFrame(event))
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
      pinch = { distance: distanceOf(a, b), scale: view.scale }
    }
    if (pointers.size === 1) {
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
    }
  }

  function onPointerMove(event: PointerEvent) {
    const last = pointers.get(event.pointerId)
    if (!last) return
    const now = inFrame(event)
    pointers.set(event.pointerId, now)
    if (pointers.size === 1) {
      moveBy(now.x - last.x, now.y - last.y)
    } else if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }]
      zoomTo(pinch.scale * (distanceOf(a, b) / pinch.distance), {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      })
    }
  }

  function onPointerUp(event: PointerEvent) {
    pointers.delete(event.pointerId)
    if (pointers.size < 2) pinch = null
    if (pointers.size === 0) stopListening()
  }

  function stopListening() {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }

  function onWheel(event: WheelEvent) {
    if (!size || busy) return
    // The page must not scroll while the wheel zooms the logo.
    event.preventDefault()
    zoomTo(view.scale * Math.exp(-event.deltaY / 300), inFrame(event))
  }

  function onKeydown(event: KeyboardEvent) {
    if (!size || busy) return
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_MOVE, 0],
      ArrowRight: [KEY_MOVE, 0],
      ArrowUp: [0, -KEY_MOVE],
      ArrowDown: [0, KEY_MOVE],
    }
    const move = moves[event.key]
    if (move) moveBy(...move)
    else if (event.key === '+' || event.key === '=') zoomTo(view.scale * KEY_ZOOM)
    else if (event.key === '-' || event.key === '_') zoomTo(view.scale / KEY_ZOOM)
    else return
    event.preventDefault()
  }

  onMount(() => {
    // Not passive: the wheel zooms instead of scrolling the page.
    frameEl?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      frameEl?.removeEventListener('wheel', onWheel)
      stopListening()
    }
  })
</script>

<div class="space-y-3" data-testid="logo-cropper">
  <div class="flex flex-wrap items-start gap-4">
    <!-- The frame is a focusable application widget: drag, wheel, pinch and keys move and zoom the image. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={frameEl}
      role="application"
      aria-roledescription="crop frame"
      aria-label="Logo crop: drag to move, scroll or pinch to zoom; arrow keys move, + and − zoom"
      tabindex="0"
      class="relative shrink-0 cursor-grab touch-none overflow-hidden rounded-md border border-border bg-muted outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      style="width:{FRAME}px;height:{FRAME}px"
      onpointerdown={onPointerDown}
      onkeydown={onKeydown}
      data-testid="logo-crop-frame"
    >
      <img
        {src}
        alt="The logo being cropped"
        draggable="false"
        class="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left {size
          ? ''
          : 'invisible'}"
        style={size ? imageStyle(size, view, 1) : ''}
        onload={onLoad}
        onerror={() => (loadError = true)}
        data-testid="logo-crop-image"
      />
      <!-- The round badge at the top left of the app shows this circle. -->
      <span
        class="pointer-events-none absolute inset-0 rounded-full ring-1 ring-foreground/30"
        aria-hidden="true"
      ></span>
    </div>
    <div class="space-y-2">
      <p class="text-xs text-muted-foreground">How it will look</p>
      <div class="flex items-center gap-3" aria-hidden="true">
        {#each [{ px: 48, round: false }, { px: 32, round: true }] as p (p.px)}
          <span
            class="relative block shrink-0 overflow-hidden border border-border bg-muted {p.round
              ? 'rounded-full'
              : 'rounded-md'}"
            style="width:{p.px}px;height:{p.px}px"
            data-testid="logo-crop-preview"
          >
            {#if size}
              <img
                {src}
                alt=""
                class="absolute top-0 left-0 max-w-none origin-top-left"
                style={imageStyle(size, view, p.px / FRAME)}
              />
            {/if}
          </span>
        {/each}
      </div>
    </div>
  </div>
  {#if loadError}
    <p class="text-xs text-destructive" role="alert">This image could not be shown for cropping.</p>
  {/if}
  <label class="flex max-w-60 items-center gap-2 text-xs text-muted-foreground">
    <span>Zoom</span>
    <input
      type="range"
      min="0"
      max={STEPS}
      step="1"
      value={step}
      disabled={!size || busy}
      oninput={onSlider}
      class="min-w-0 flex-1 accent-foreground"
      data-testid="logo-crop-zoom"
    />
  </label>
  <div class="flex flex-wrap gap-2">
    <Button
      type="button"
      size="sm"
      disabled={!size || busy}
      onclick={() => onsave(cropOf(view, FRAME))}
      data-testid="logo-crop-save">Save logo</Button
    >
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!size || busy}
      onclick={() => size && (view = fitView(size, FRAME))}
      data-testid="logo-crop-fit">Show it whole</Button
    >
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={busy}
      onclick={oncancel}
      data-testid="logo-crop-cancel">Cancel</Button
    >
  </div>
</div>
