<script lang="ts">
  import type { SocialMedia } from '../../../../../modules/brand/social/types'
  import type { PdfPages } from './social-pdf'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { mediaUrl } from './social-api'

  /**
   * An uploaded post's slides (wishes 98f18047, 55fdb281): images or a PDF's
   * pages, one at a time. Clicking the slide goes to the next one (never a
   * download); arrows, the thumbnails and ←/→ page through. The one Download
   * button saves the file behind the slide you see (a PDF: the whole PDF).
   */
  let {
    media,
    title,
    pdfPages,
  }: { media: SocialMedia[]; title: string; pdfPages: PdfPages } = $props()

  type Slide = { src: string; file: SocialMedia; label: string }

  // svelte-ignore state_referenced_locally
  const pdf = media.find((m) => m.mime === 'application/pdf') ?? null
  let pages = $state<string[] | null>(null)
  let pdfError = $state<string | null>(null)
  let index = $state(0)

  const slides = $derived<Slide[]>(
    pdf
      ? (pages ?? []).map((src, i) => ({ src, file: pdf, label: `${title} · page ${i + 1}` }))
      : media.map((m) => ({ src: mediaUrl(m.id), file: m, label: m.name })),
  )
  const current = $derived(slides[index] ?? null)

  onMount(() => {
    if (!pdf) return
    pdfPages(mediaUrl(pdf.id)).then(
      (p) => (pages = p),
      (err: unknown) => (pdfError = err instanceof Error ? err.message : String(err)),
    )
  })

  const go = (i: number) => (index = Math.max(0, Math.min(slides.length - 1, i)))
  const onSlideClick = () => go(index + 1 < slides.length ? index + 1 : 0)
  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'ArrowRight') go(index + 1)
    else if (e.key === 'ArrowLeft') go(index - 1)
    else return
    e.preventDefault()
  }
</script>

<div class="flex flex-col gap-2" data-testid="social-media-viewer">
  {#if pdf && pdfError}
    <p class="text-sm text-destructive" role="alert">{pdfError}</p>
  {:else if pdf && !pages}
    <p
      class="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground"
      role="status"
    >
      Drawing the PDF’s pages…
    </p>
  {:else if current}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="relative"
      role="group"
      aria-roledescription="carousel"
      aria-label={pdf ? `${pdf.name}, pages` : 'Slides'}
      tabindex="0"
      {onkeydown}
    >
      <button
        type="button"
        class="block w-full cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        aria-label={slides.length > 1 ? 'Show the next slide' : current.label}
        onclick={onSlideClick}
        draggable="false"
        tabindex="-1"
      >
        <img
          class="w-full rounded-lg border border-border object-contain select-none"
          src={current.src}
          alt={current.label}
          draggable="false"
          data-testid="social-slide"
        />
      </button>
    </div>
    <div class="flex items-center gap-2">
      {#if slides.length > 1}
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous slide"
          disabled={index === 0}
          onclick={() => go(index - 1)}><ChevronLeft aria-hidden="true" /></Button
        >
        <span class="text-xs tabular-nums text-muted-foreground" data-testid="social-slide-count"
          >{index + 1} / {slides.length}</span
        >
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next slide"
          disabled={index === slides.length - 1}
          onclick={() => go(index + 1)}><ChevronRight aria-hidden="true" /></Button
        >
      {/if}
      <Button
        class="ml-auto"
        variant="outline"
        size="sm"
        href={mediaUrl(current.file.id, true)}
        download={current.file.name}>Download {current.file.name}</Button
      >
    </div>
    {#if slides.length > 1}
      <ul class="flex gap-2 overflow-x-auto pb-1" aria-label="Carousel">
        {#each slides as s, i (i)}
          <li class="shrink-0">
            <button
              type="button"
              class="block rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              aria-label={`Slide ${i + 1}`}
              aria-current={i === index ? 'true' : undefined}
              onclick={() => go(i)}
            >
              <img
                class="size-16 rounded-md border object-cover {i === index
                  ? 'border-foreground/70'
                  : 'border-border opacity-70'}"
                src={s.src}
                alt=""
                draggable="false"
              />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>
