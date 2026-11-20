<script lang="ts">
  import type { OfficeViewerProps } from '../viewers'
  import type { RenderEnv } from './render'
  import InfoIcon from '@lucide/svelte/icons/info'
  import MoveHorizontalIcon from '@lucide/svelte/icons/move-horizontal'
  import ZoomInIcon from '@lucide/svelte/icons/zoom-in'
  import ZoomOutIcon from '@lucide/svelte/icons/zoom-out'
  import { onMount, tick } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { driveApi } from '$lib/drive/api'
  import { parseDocx } from './model'
  import { LayoutAborted, paginate } from './paginate'
  import { PX_PER_PT } from './render'

  /**
   * Word document viewer (plan/phase-office-files.md D1): the pages at their
   * true size with margins, headers and footers, content flowing from page
   * to page; zoom to fit the width or 100%; the text selectable. View only —
   * `canEdit` comes into play with editing (D2).
   */
  let { fileId, name }: OfficeViewerProps = $props()

  type Phase = 'loading' | 'layout' | 'ready' | 'error'
  let phase = $state<Phase>('loading')
  let error = $state<string | null>(null)
  let notices = $state<string[]>([])
  let pageCount = $state(0)
  let pageLabels = $state<string[]>([])
  let current = $state(1)
  /** 'fit' follows the width of the view; a number is a fixed zoom (1 = 100%). */
  let zoom = $state<'fit' | number>('fit')
  let fitScale = $state(1)
  let widestPt = $state(612)
  let scroller = $state<HTMLDivElement>()
  let host = $state<HTMLDivElement>()

  const scale = $derived(zoom === 'fit' ? fitScale : zoom)
  const percent = $derived(Math.round(scale * 100))

  /** Picture types a browser shows in <img>; others (EMF, WMF, TIFF) get a placeholder. */
  const SHOWN = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/bmp', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/avif'])

  function measureFit() {
    if (!scroller) return
    const available = scroller.clientWidth - 32
    if (available <= 0) return
    fitScale = Math.max(0.2, Math.min(2, available / (widestPt * PX_PER_PT)))
  }

  function onScroll() {
    if (!scroller || !host) return
    const y = scroller.scrollTop + scroller.clientHeight / 3 - host.offsetTop
    const frames = host.children
    let n = 1
    for (let i = 0; i < frames.length; i++) {
      if ((frames[i] as HTMLElement).offsetTop <= y) n = i + 1
      else break
    }
    current = n
  }

  /** Links to a bookmark inside the document scroll to it instead of navigating. */
  function onClick(event: MouseEvent) {
    const target = event.target
    if (!(target instanceof Element) || !host) return
    const a = target.closest<HTMLAnchorElement>('a[data-anchor]')
    if (!a) return
    event.preventDefault()
    const mark = host.querySelector(`[data-bookmark="${CSS.escape(a.dataset.anchor ?? '')}"]`)
    mark?.scrollIntoView({ block: 'start' })
  }

  function zoomBy(step: number) {
    const next = Math.round((scale + step) * 10) / 10
    zoom = Math.max(0.3, Math.min(3, next))
  }

  onMount(() => {
    const controller = new AbortController()
    const urls: string[] = []
    const resize = new ResizeObserver(() => measureFit())
    if (scroller) resize.observe(scroller)
    void open(controller.signal, urls)
    return () => {
      controller.abort()
      resize.disconnect()
      for (const u of urls) URL.revokeObjectURL(u)
    }
  })

  async function open(signal: AbortSignal, urls: string[]) {
    try {
      const bytes = await driveApi.readBytes(fileId)
      if (signal.aborted) return
      const doc = parseDocx(bytes)
      notices = doc.notices
      widestPt = Math.max(...doc.sections.map((s) => s.props.pageWidthPt))
      phase = 'layout'
      measureFit()
      await tick()
      await document.fonts?.ready
      if (signal.aborted || !host) return
      const cache = new Map<string, string | null>()
      const env: Omit<RenderEnv, 'pageField'> = {
        doc,
        document,
        imageUrl(part, contentType) {
          if (cache.has(part)) return cache.get(part)!
          const type = (contentType ?? '').toLowerCase()
          let url: string | null = null
          if (SHOWN.has(type)) {
            url = URL.createObjectURL(new Blob([doc.pkg.bytes(part).slice()], { type }))
            urls.push(url)
          }
          cache.set(part, url)
          return url
        },
      }
      const pages = await paginate(doc, host, env, { signal, onPage: (n) => (pageCount = n) })
      pageLabels = pages.map((p) => p.number)
      pageCount = pages.length
      phase = 'ready'
      onScroll()
    } catch (err) {
      if (err instanceof LayoutAborted || signal.aborted) return
      error = err instanceof Error ? err.message : String(err)
      phase = 'error'
    }
  }
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="docx-viewer">
  <div class="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm" role="toolbar" aria-label="Document view">
    <span class="tabular-nums text-muted-foreground" data-testid="docx-page-indicator" aria-live="polite">
      {#if phase === 'ready'}
        Page {current} of {pageCount}{pageLabels[current - 1] && pageLabels[current - 1] !== String(current) ? ` (numbered ${pageLabels[current - 1]})` : ''}
      {:else if phase === 'layout'}
        Laying out pages… {pageCount > 0 ? pageCount : ''}
      {:else if phase === 'loading'}
        Opening {name}…
      {/if}
    </span>
    <div class="ms-auto flex items-center gap-1">
      <Button variant="ghost" size="icon-sm" aria-label="Zoom out" onclick={() => zoomBy(-0.1)} disabled={phase === 'error'}>
        <ZoomOutIcon />
      </Button>
      <span class="w-12 text-center tabular-nums text-muted-foreground" data-testid="docx-zoom">{percent}%</span>
      <Button variant="ghost" size="icon-sm" aria-label="Zoom in" onclick={() => zoomBy(0.1)} disabled={phase === 'error'}>
        <ZoomInIcon />
      </Button>
      <Button
        variant={zoom === 'fit' ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={zoom === 'fit'}
        onclick={() => {
          zoom = 'fit'
          measureFit()
        }}
        disabled={phase === 'error'}
        data-testid="docx-zoom-fit"
      >
        <MoveHorizontalIcon />
        Fit width
      </Button>
      <Button
        variant={zoom === 1 ? 'secondary' : 'ghost'}
        size="sm"
        aria-pressed={zoom === 1}
        onclick={() => (zoom = 1)}
        disabled={phase === 'error'}
        data-testid="docx-zoom-actual"
      >
        100%
      </Button>
    </div>
  </div>
  {#if notices.length > 0}
    <ul class="flex flex-col gap-1 border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground" data-testid="docx-notices">
      {#each notices as notice (notice)}
        <li class="flex items-center gap-1.5"><InfoIcon class="size-3.5 shrink-0" />{notice}</li>
      {/each}
    </ul>
  {/if}
  {#if phase === 'error'}
    <p class="m-6 text-sm text-destructive" role="alert" data-testid="docx-error">
      This Word document could not be opened: {error}
    </p>
  {/if}
  <div
    bind:this={scroller}
    class="relative min-h-[75vh] flex-1 overflow-auto bg-muted/60"
    class:hidden={phase === 'error'}
    onscroll={onScroll}
    data-testid="docx-scroller"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions (delegated: the links inside the pages are the interactive elements) -->
    <div
      bind:this={host}
      class="docx-pages flex w-max min-w-full flex-col gap-4 p-4"
      style:--docx-scale={scale}
      role="document"
      aria-label={name}
      aria-busy={phase !== 'ready'}
      onclick={onClick}
    ></div>
  </div>
</div>

<style>
  /* The pages are built outside Svelte's markup (paginate.ts): only undo app-wide element styles inside them. */
  .docx-pages :global(.docx-page img) {
    max-width: none;
  }
  .docx-pages :global(.docx-page p) {
    hyphens: manual;
  }
  .docx-pages :global(.docx-page table) {
    caption-side: top;
  }
  .docx-pages :global(.docx-page a[href]) {
    cursor: pointer;
  }
  .docx-pages :global(.docx-page ::selection) {
    background: rgb(59 130 246 / 0.3);
  }
</style>
