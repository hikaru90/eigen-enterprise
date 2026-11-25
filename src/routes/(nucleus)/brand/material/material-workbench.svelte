<script lang="ts">
  import type { MaterialTextSuggestions } from '../../../../../modules/brand/material/texts'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'
  import { brandShownError } from '../brand-errors'
  import { saveBlob } from '../social/social-export'
  import BannerPreview from './banner-preview.svelte'
  import FlyerPreview from './flyer-preview.svelte'
  import {
    MATERIAL_KINDS,
    exportOf,
    formatById,
    formatsOf,
    sizeLabel,
    type MaterialKind,
  } from './formats'
  import { materialApi, type MaterialApi } from './material-api'
  import MerchPreview from './merch-preview.svelte'
  import PosterPreview from './poster-preview.svelte'

  /**
   * Pick a kind of brand material and a standard size, write the copy once
   * (or have the AI write variants in the brand voice and edit the one you
   * pick), and see it in the active style with the company logo. Download
   * exports it print-ready (brand.material_export): PDF for paper, PNG for
   * the social header and merch. The copy carries over between kinds.
   */
  let {
    style,
    logoUrl,
    api = materialApi(),
    save = saveBlob,
  }: {
    style: {
      name: string
      cssVars: Record<string, string>
      darkCssVars: Record<string, string> | null
    }
    /** The company logo (Settings → Company); null when none is set. */
    logoUrl: string | null
    api?: MaterialApi
    save?: (blob: Blob, filename: string) => void
  } = $props()

  let kind = $state<MaterialKind>('flyer')
  let formatId = $state(formatsOf('flyer')[0].id)
  let mode = $state<'light' | 'dark'>('light')
  let headline = $state('Your headline')
  let body = $state('One or two sentences about what you are announcing.')
  let cta = $state('Find out more')
  let showLogo = $state(true)
  let brief = $state('')
  let writing = $state(false)
  let suggestions = $state<MaterialTextSuggestions | null>(null)
  let textsError = $state<ShownError | null>(null)
  let exporting = $state(false)
  let exportError = $state<ShownError | null>(null)

  const formats = $derived(formatsOf(kind))
  const format = $derived(formatById(formatId))
  const out = $derived(exportOf(format))
  const placedLogo = $derived(logoUrl && showLogo ? logoUrl : null)

  function chooseKind(next: MaterialKind) {
    kind = next
    formatId = formatsOf(next)[0].id
    suggestions = null
  }

  async function writeTexts() {
    writing = true
    textsError = null
    suggestions = null
    try {
      suggestions = await api.suggestTexts({ formatId, ...(brief.trim() ? { brief: brief.trim() } : {}) })
    } catch (err) {
      textsError = brandShownError(err)
    } finally {
      writing = false
    }
  }

  function useVariant(v: { headline: string; body?: string; cta?: string }) {
    headline = v.headline
    if (v.body !== undefined) body = v.body
    if (v.cta !== undefined) cta = v.cta
  }

  async function download() {
    exporting = true
    exportError = null
    try {
      const file = await api.exportFile({
        formatId,
        mode,
        headline,
        ...(kind === 'merch' ? {} : { body, cta }),
        logo: placedLogo !== null,
      })
      save(file.blob, file.filename)
    } catch (err) {
      exportError = brandShownError(err)
    } finally {
      exporting = false
    }
  }
</script>

<div class="flex flex-col gap-6">
  <ul class="flex flex-wrap gap-2" data-testid="material-types">
    {#each MATERIAL_KINDS as k (k.id)}
      <li>
        <Button
          size="sm"
          variant={kind === k.id ? 'default' : 'outline'}
          aria-pressed={kind === k.id}
          onclick={() => chooseKind(k.id)}
        >
          {k.label}
        </Button>
      </li>
    {/each}
  </ul>

  <section class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
    <form class="flex flex-col gap-4" onsubmit={(e) => e.preventDefault()}>
      {#if formats.length > 1}
        <div class="flex flex-wrap gap-2" role="group" aria-label="Size">
          {#each formats as f (f.id)}
            <Button
              size="sm"
              variant={format.id === f.id ? 'secondary' : 'ghost'}
              aria-pressed={format.id === f.id}
              onclick={() => (formatId = f.id)}
            >
              {f.label}
            </Button>
          {/each}
        </div>
      {/if}
      <p class="text-sm text-muted-foreground" data-testid="material-size">
        {format.label} · {sizeLabel(format)}
      </p>

      <div class="flex flex-col gap-2 rounded-md border border-border p-3">
        <Label for="material-brief">{m.material_brief_label()}</Label>
        <div class="flex flex-wrap gap-2">
          <Input
            id="material-brief"
            class="min-w-0 flex-1"
            placeholder={m.material_brief_placeholder()}
            bind:value={brief}
          />
          <Button variant="outline" size="sm" onclick={writeTexts} disabled={writing}>
            {writing ? m.material_writing_texts() : m.material_write_texts()}
          </Button>
        </div>
        {#if textsError}
          <ErrorNotice
            error={textsError.error}
            agent={textsError.agent}
            attempted="Writing texts for brand material (Brand › Material)"
          />
        {/if}
        {#if suggestions}
          <p class="text-xs text-foreground/55">
            {suggestions.voice ? m.material_texts_hint() : m.material_texts_no_voice()}
          </p>
          <ol class="flex flex-col gap-2" data-testid="material-variants">
            {#each suggestions.variants as v, i (i)}
              <li class="flex items-start justify-between gap-3 rounded-md bg-muted/50 p-2 text-sm">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-medium break-words">{v.headline}</span>
                  {#if v.body}<span class="break-words text-foreground/70">{v.body}</span>{/if}
                  {#if v.cta}<span class="text-xs text-foreground/55">{v.cta}</span>{/if}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={m.material_use_variant_label({ n: i + 1 })}
                  onclick={() => useVariant(v)}
                >
                  {m.material_use_variant()}
                </Button>
              </li>
            {/each}
          </ol>
        {/if}
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="material-headline">{kind === 'merch' ? 'Slogan' : 'Headline'}</Label>
        <Input id="material-headline" bind:value={headline} />
      </div>
      {#if kind !== 'merch'}
        <div class="flex flex-col gap-1.5">
          <Label for="material-body">Text</Label>
          <Textarea id="material-body" bind:value={body} rows={3} />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="material-cta">Button</Label>
          <Input id="material-cta" bind:value={cta} />
        </div>
      {/if}
      <div class="flex flex-wrap items-center gap-4">
        <div
          class="inline-flex w-fit rounded-md border border-border p-0.5"
          role="group"
          aria-label="Preview theme"
        >
          {#each ['light', 'dark'] as const as md (md)}
            <Button
              size="sm"
              variant={mode === md ? 'default' : 'ghost'}
              aria-pressed={mode === md}
              onclick={() => (mode = md)}
            >
              {md === 'light' ? 'Light' : 'Dark'}
            </Button>
          {/each}
        </div>
        {#if logoUrl}
          <div class="flex items-center gap-2">
            <Checkbox id="material-logo" bind:checked={showLogo} />
            <Label for="material-logo">{m.material_logo_toggle()}</Label>
          </div>
        {/if}
      </div>
      {#if !logoUrl}
        <p class="text-xs text-foreground/55">{m.material_logo_missing()}</p>
      {/if}

      <div class="flex flex-col gap-2 border-t border-border pt-4">
        <div class="flex flex-wrap items-center gap-3">
          <Button onclick={download} disabled={exporting}>
            {exporting
              ? m.material_downloading()
              : out.kind === 'pdf'
                ? m.material_download_pdf()
                : m.material_download_png()}
          </Button>
          <span class="text-xs text-foreground/55" data-testid="material-export-hint">
            {out.kind === 'pdf'
              ? m.material_export_pdf_hint({ size: sizeLabel(format) })
              : m.material_export_png_hint({ width: out.pixelWidth, height: out.pixelHeight })}
          </span>
        </div>
        {#if exportError}
          <ErrorNotice
            error={exportError.error}
            agent={exportError.agent}
            attempted="Exporting brand material (Brand › Material)"
          />
        {/if}
      </div>
    </form>
    {#if kind === 'flyer'}
      <FlyerPreview
        setName={style.name}
        logoUrl={placedLogo}
        cssVars={style.cssVars}
        darkCssVars={style.darkCssVars}
        {mode}
        {headline}
        {body}
        {cta}
      />
    {:else if kind === 'banner'}
      <BannerPreview
        setName={style.name}
        logoUrl={placedLogo}
        cssVars={style.cssVars}
        darkCssVars={style.darkCssVars}
        {mode}
        {format}
        {headline}
        {body}
        {cta}
      />
    {:else if kind === 'poster'}
      <PosterPreview
        setName={style.name}
        logoUrl={placedLogo}
        cssVars={style.cssVars}
        darkCssVars={style.darkCssVars}
        {mode}
        {format}
        {headline}
        {body}
        {cta}
      />
    {:else}
      <MerchPreview
        setName={style.name}
        logoUrl={placedLogo}
        cssVars={style.cssVars}
        darkCssVars={style.darkCssVars}
        {mode}
        {format}
        {headline}
      />
    {/if}
  </section>
</div>
