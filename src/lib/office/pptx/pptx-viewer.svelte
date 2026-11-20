<script lang="ts">
  /* eslint-disable svelte/no-at-html-tags -- slide markup comes from ./render.ts, which escapes every value read from the file and only emits http(s)/mailto links and our own blob: image URLs */
  import type { OfficeViewerProps } from '../viewers'
  import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import EyeOffIcon from '@lucide/svelte/icons/eye-off'
  import NotebookTextIcon from '@lucide/svelte/icons/notebook-text'
  import PresentationIcon from '@lucide/svelte/icons/presentation'
  import XIcon from '@lucide/svelte/icons/x'
  import { onDestroy, onMount, tick } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi } from '$lib/drive/api'
  import { createMediaSource } from './media'
  import { openDeck, type Deck, type Slide } from './model'
  import { renderSlideSvg, type MediaSource } from './render'
  import { resolveSlide } from './resolve'

  /**
   * PowerPoint viewer (plan/phase-office-files.md, S1): the current slide
   * large, a thumbnail rail, previous/next (buttons, arrow keys, Page
   * Up/Down, Home/End), the slide counter, speaker notes, and presenter mode
   * (full screen, keys or click to advance, Esc to leave). View only for now:
   * `canEdit` is not used until editing lands (S2).
   */
  let { fileId, name }: OfficeViewerProps = $props()

  type View = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: Deck }
  // Raw: the deck is plain data with source links keyed by object identity; no deep proxy.
  let view = $state.raw<View>({ status: 'loading' })
  let current = $state(0)
  let showNotes = $state(true)
  let presenting = $state(false)
  let fullscreenRefused = $state(false)
  let thumbsShown = $state<Record<number, boolean>>({})
  let rootEl = $state<HTMLDivElement | null>(null)
  let railEl = $state<HTMLOListElement | null>(null)
  let presenterEl = $state<HTMLDivElement | null>(null)

  let media: MediaSource = () => null
  let disposeMedia = () => {}
  let wentFullscreen = false
  /** Drawn slides by place and index: a plain cache, not view state. */
  const drawn: Record<string, { svg: string } | { error: string }> = {}

  const deck = $derived(view.status === 'ready' ? view.deck : null)
  const count = $derived(deck?.slides.length ?? 0)
  const slide = $derived<Slide | null>(deck?.slides[current] ?? null)
  const aspect = $derived(deck ? deck.size.cx / deck.size.cy : 16 / 9)
  const notes = $derived(
    (slide?.notes?.paragraphs ?? [])
      .map((p) =>
        p.runs
          .map((r) => (r.kind === 'break' ? '\n' : r.kind === 'field' && r.type === 'slidenum' ? String(slide!.number) : r.text))
          .join(''),
      )
      .filter((t) => t.trim() !== ''),
  )

  onMount(() => {
    void load()
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  })
  onDestroy(() => disposeMedia())

  async function load() {
    try {
      const bytes = await driveApi.readBytes(fileId)
      const opened = openDeck(bytes)
      const source = createMediaSource(opened.pkg)
      media = source.media
      disposeMedia = source.dispose
      view = { status: 'ready', deck: opened.deck }
      rootEl?.focus({ preventScroll: true })
    } catch (err) {
      view = { status: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  /** One slide's SVG for a place on the page (main, thumbnail, presenter), drawn once. */
  function draw(index: number, place: 'main' | 'thumb' | 'show'): { svg: string } | { error: string } {
    const key = `${place}:${index}`
    const hit = drawn[key]
    if (hit) return hit
    let out: { svg: string } | { error: string }
    try {
      out = { svg: renderSlideSvg(resolveSlide(deck!, index), { idPrefix: `pptx-${place}-${index}`, media, links: place !== 'thumb' }) }
    } catch (err) {
      out = { error: err instanceof Error ? err.message : String(err) }
    }
    drawn[key] = out
    return out
  }

  async function go(index: number) {
    if (!deck || count === 0) return
    current = Math.max(0, Math.min(count - 1, index))
    await tick()
    railEl?.querySelector(`[data-thumb="${current}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }

  /** The next slide in this direction; presenter mode skips hidden slides. */
  function step(dir: 1 | -1) {
    if (!deck) return
    let i = current + dir
    while (presenting && i >= 0 && i < count && deck.slides[i]!.hidden) i += dir
    if (i >= 0 && i < count) void go(i)
  }

  function edge(to: 'first' | 'last') {
    if (!deck) return
    const order = deck.slides.map((_, i) => i)
    if (to === 'last') order.reverse()
    const i = order.find((k) => !presenting || !deck.slides[k]!.hidden)
    if (i !== undefined) void go(i)
  }

  function onKeydown(event: KeyboardEvent) {
    if (!deck || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return
    const link = target instanceof Element ? target.closest('[data-slide-link]') : null
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
      case 'PageDown':
        step(1)
        break
      case ' ':
        if (target instanceof HTMLButtonElement && !presenting) return
        step(1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
      case 'PageUp':
        step(-1)
        break
      case 'Home':
        edge('first')
        break
      case 'End':
        edge('last')
        break
      case 'Enter':
        if (!link) return
        void go(Number(link.getAttribute('data-slide-link')))
        break
      case 'Escape':
        if (!presenting) return
        void stopPresenting()
        break
      default:
        return
    }
    event.preventDefault()
  }

  /** Clicks on a slide link (a jump to another slide inside the deck). */
  function onSlideClick(event: MouseEvent) {
    const link = event.target instanceof Element ? event.target.closest('[data-slide-link]') : null
    if (!link) return
    event.preventDefault()
    void go(Number(link.getAttribute('data-slide-link')))
  }

  function onPresenterClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('a[href]') || target?.closest('button')) return
    const link = target?.closest('[data-slide-link]')
    if (link) void go(Number(link.getAttribute('data-slide-link')))
    else step(1)
  }

  async function present() {
    if (!deck) return
    if (deck.slides[current]?.hidden) {
      const next = deck.slides.findIndex((s, i) => i >= current && !s.hidden)
      if (next >= 0) current = next
    }
    presenting = true
    fullscreenRefused = false
    await tick()
    presenterEl?.focus()
    if (!presenterEl?.requestFullscreen) {
      fullscreenRefused = true
      return
    }
    try {
      await presenterEl.requestFullscreen()
      wentFullscreen = true
    } catch {
      // The browser refused full screen (policy or no user gesture): presenting stays in the window, and says so.
      fullscreenRefused = true
    }
  }

  async function stopPresenting() {
    presenting = false
    if (document.fullscreenElement) {
      wentFullscreen = false
      await document.exitFullscreen()
    }
    await tick()
    rootEl?.focus({ preventScroll: true })
  }

  function onFullscreenChange() {
    // Leaving full screen (Esc handled by the browser, F11 …) ends presenting too.
    if (!document.fullscreenElement && wentFullscreen) {
      wentFullscreen = false
      if (presenting) void stopPresenting()
    }
  }

  /** Thumbnails draw when they come near the rail's visible area. */
  function whenVisible(index: number) {
    return (node: HTMLElement) => {
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            thumbsShown[index] = true
            io.disconnect()
          }
        },
        { rootMargin: '300px' },
      )
      io.observe(node)
      return () => io.disconnect()
    }
  }
</script>

{#snippet slideBox(index: number, place: 'main' | 'thumb' | 'show')}
  {@const out = draw(index, place)}
  {#if 'svg' in out}
    {@html out.svg}
  {:else}
    <div class="flex h-full w-full items-center justify-center bg-white p-4 text-center text-sm text-destructive" role="alert" data-testid="pptx-slide-error">
      Slide {index + 1} could not be drawn: {out.error}
    </div>
  {/if}
{/snippet}

<!-- The viewer takes the slide keys (arrows, Page Up/Down, Home/End, Esc while presenting) for everything inside it. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={rootEl}
  class="flex min-h-0 flex-1 flex-col outline-none"
  tabindex="-1"
  role="region"
  aria-label={`Slides of ${name}`}
  onkeydown={onKeydown}
  data-testid="pptx-viewer"
>
  {#if view.status === 'loading'}
    <div class="flex flex-1 items-center justify-center text-sm text-muted-foreground" data-testid="pptx-loading">Opening {name}…</div>
  {:else if view.status === 'error'}
    <div class="m-6 flex flex-col gap-1 text-sm" role="alert" data-testid="pptx-error">
      <p class="font-medium text-destructive">This presentation could not be opened.</p>
      <p class="text-muted-foreground">{view.message}</p>
    </div>
  {:else if count === 0}
    <p class="m-6 text-sm text-muted-foreground" data-testid="pptx-empty">This presentation has no slides.</p>
  {:else}
    <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
      <Button variant="ghost" size="icon-sm" aria-label="Previous slide" title="Previous slide (←)" disabled={current === 0} onclick={() => step(-1)} data-testid="pptx-prev">
        <ChevronLeftIcon class="size-4" aria-hidden="true" />
      </Button>
      <span class="min-w-24 text-center text-sm tabular-nums" aria-live="polite" data-testid="pptx-counter">Slide {current + 1} of {count}</span>
      <Button variant="ghost" size="icon-sm" aria-label="Next slide" title="Next slide (→)" disabled={current === count - 1} onclick={() => step(1)} data-testid="pptx-next">
        <ChevronRightIcon class="size-4" aria-hidden="true" />
      </Button>
      {#if slide?.hidden}
        <span class="inline-flex items-center gap-1 rounded-full border px-2 py-px text-xs text-muted-foreground" data-testid="pptx-hidden-badge">
          <EyeOffIcon class="size-3" aria-hidden="true" /> Hidden in the slide show
        </span>
      {/if}
      <div class="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" aria-pressed={showNotes} onclick={() => (showNotes = !showNotes)} data-testid="pptx-notes-toggle">
          <NotebookTextIcon class="size-4" aria-hidden="true" /> Notes
        </Button>
        <Button size="sm" onclick={() => void present()} title="Present full screen (Esc to stop)" data-testid="pptx-present">
          <PresentationIcon class="size-4" aria-hidden="true" /> Present
        </Button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1">
      <ol bind:this={railEl} class="hidden w-44 shrink-0 flex-col gap-3 overflow-y-auto border-r p-3 sm:flex" aria-label="Slides" data-testid="pptx-rail">
        {#each deck!.slides as s, i (s.part)}
          <li class="flex items-start gap-2" data-thumb={i}>
            <span class="w-5 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums" aria-hidden="true">{i + 1}</span>
            <button
              type="button"
              class={`block w-full overflow-hidden rounded-sm border bg-white outline-none focus-visible:ring-2 focus-visible:ring-ring ${i === current ? 'border-primary ring-2 ring-primary' : 'border-border hover:border-foreground/40'} ${s.hidden ? 'opacity-50' : ''}`}
              style={`aspect-ratio:${aspect}`}
              aria-label={`Slide ${i + 1}${s.hidden ? ' (hidden)' : ''}`}
              aria-current={i === current ? 'true' : undefined}
              onclick={() => void go(i)}
              {@attach whenVisible(i)}
              data-testid="pptx-thumb"
            >
              <span class="pointer-events-none block h-full w-full" aria-hidden="true" inert>
                {#if thumbsShown[i]}{@render slideBox(i, 'thumb')}{/if}
              </span>
            </button>
          </li>
        {/each}
      </ol>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="flex min-h-0 flex-1 items-center justify-center bg-muted/30 p-4">
          <!-- Slide links are reached by keyboard through the viewer's Enter handling. -->
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div
            class="overflow-hidden bg-white shadow-sm ring-1 ring-border"
            style={`aspect-ratio:${aspect};width:min(100%, calc(68vh * ${aspect}))`}
            onclick={onSlideClick}
            data-testid="pptx-slide"
          >
            {#key current}{@render slideBox(current, 'main')}{/key}
          </div>
        </div>
        {#if showNotes}
          <section class="max-h-48 shrink-0 overflow-y-auto border-t px-4 py-3 text-sm" aria-label="Speaker notes" data-testid="pptx-notes">
            {#if notes.length === 0}
              <p class="text-muted-foreground">No speaker notes on this slide.</p>
            {:else}
              {#each notes as line, i (i)}
                <p class="whitespace-pre-wrap">{line}</p>
              {/each}
            {/if}
          </section>
        {/if}
      </div>
    </div>
  {/if}

  {#if presenting && deck}
    <!-- Presenter mode takes the keys on this element (the viewer's keydown handler). -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      bind:this={presenterEl}
      class="fixed inset-0 z-50 flex items-center justify-center bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={`Presenting ${name}`}
      tabindex="0"
      onclick={onPresenterClick}
      data-testid="pptx-presenter"
    >
      <div class="overflow-hidden bg-white" style={`aspect-ratio:${aspect};width:min(100vw, calc(100vh * ${aspect}))`} data-testid="pptx-presenter-slide">
        {#key current}{@render slideBox(current, 'show')}{/key}
      </div>
      <div class="absolute top-3 right-3 flex items-center gap-2 text-xs text-white/70">
        {#if fullscreenRefused}<span data-testid="pptx-no-fullscreen">Full screen is not available here — presenting in the window.</span>{/if}
        <span class="tabular-nums">{current + 1} / {count}</span>
        <button type="button" class="rounded p-1 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none" aria-label="Stop presenting (Esc)" onclick={() => void stopPresenting()} data-testid="pptx-presenter-close">
          <XIcon class="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  {/if}
</div>
