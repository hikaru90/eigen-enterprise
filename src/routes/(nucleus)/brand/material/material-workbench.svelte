<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import BannerPreview from './banner-preview.svelte'
  import FlyerPreview from './flyer-preview.svelte'
  import { MATERIAL_KINDS, formatById, formatsOf, sizeLabel, type MaterialKind } from './formats'
  import MerchPreview from './merch-preview.svelte'
  import PosterPreview from './poster-preview.svelte'

  /**
   * Pick a kind of brand material and a standard size, write the copy once,
   * and see it in the active style. The copy carries over between kinds.
   */
  let {
    style,
  }: {
    style: {
      name: string
      cssVars: Record<string, string>
      darkCssVars: Record<string, string> | null
    }
  } = $props()

  let kind = $state<MaterialKind>('flyer')
  let formatId = $state(formatsOf('flyer')[0].id)
  let mode = $state<'light' | 'dark'>('light')
  let headline = $state('Your headline')
  let body = $state('One or two sentences about what you are announcing.')
  let cta = $state('Find out more')

  const formats = $derived(formatsOf(kind))
  const format = $derived(formatById(formatId))

  function chooseKind(next: MaterialKind) {
    kind = next
    formatId = formatsOf(next)[0].id
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
      <p class="text-sm text-foreground/55" data-testid="material-size">
        {format.label} · {sizeLabel(format)}
      </p>
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
      <div
        class="inline-flex w-fit rounded-md border border-border p-0.5"
        role="group"
        aria-label="Preview theme"
      >
        {#each ['light', 'dark'] as const as m (m)}
          <Button
            size="sm"
            variant={mode === m ? 'default' : 'ghost'}
            aria-pressed={mode === m}
            onclick={() => (mode = m)}
          >
            {m === 'light' ? 'Light' : 'Dark'}
          </Button>
        {/each}
      </div>
    </form>
    {#if kind === 'flyer'}
      <FlyerPreview
        setName={style.name}
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
        cssVars={style.cssVars}
        darkCssVars={style.darkCssVars}
        {mode}
        {format}
        {headline}
      />
    {/if}
  </section>
</div>
