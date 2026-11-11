<script lang="ts">
  import type { PageData } from './$types'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import { docTitle } from '$lib/shell/title'
  import FlyerPreview from './flyer-preview.svelte'

  /**
   * Brand material (Contribute idea): reusable pieces drawn from the active
   * style. First slice: the digital flyer; banner, poster and merch are
   * listed and come next.
   */
  let { data }: { data: PageData } = $props()

  const TYPES = [
    { id: 'flyer', label: 'Digital flyer', ready: true },
    { id: 'banner', label: 'Banner', ready: false },
    { id: 'poster', label: 'Trade-show poster', ready: false },
    { id: 'merch', label: 'Merch', ready: false },
  ] as const

  let mode = $state<'light' | 'dark'>('light')
  let headline = $state('Your headline')
  let body = $state('One or two sentences about what you are announcing.')
  let cta = $state('Find out more')
</script>

<svelte:head>
  <title>{docTitle('Material', 'Brand')}</title>
</svelte:head>

<div class="mt-8 flex w-full flex-col gap-6">
  <header class="flex flex-col gap-1">
    <h2 class="text-base font-semibold tracking-tight">Brand material</h2>
    <p class="text-sm text-foreground/55">Reusable pieces in your company's style.</p>
  </header>

  <ul class="flex flex-wrap gap-2" data-testid="material-types">
    {#each TYPES as t (t.id)}
      <li class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
        {t.label}
        {#if !t.ready}<Badge variant="secondary">Coming</Badge>{/if}
      </li>
    {/each}
  </ul>

  {#if !data.style}
    <div
      class="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border px-6 py-16 text-center"
      data-testid="material-empty"
    >
      <h2 class="text-lg font-semibold">Choose a style first</h2>
      <p class="max-w-sm text-sm text-foreground/55">
        Brand material is drawn from your active style.
      </p>
      <Button href="/brand">Choose a style</Button>
    </div>
  {:else}
    <section class="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <form class="flex flex-col gap-4" onsubmit={(e) => e.preventDefault()}>
        <div class="flex flex-col gap-1.5">
          <Label for="flyer-headline">Headline</Label>
          <Input id="flyer-headline" bind:value={headline} />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="flyer-body">Text</Label>
          <Textarea id="flyer-body" bind:value={body} rows={3} />
        </div>
        <div class="flex flex-col gap-1.5">
          <Label for="flyer-cta">Button</Label>
          <Input id="flyer-cta" bind:value={cta} />
        </div>
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
      <FlyerPreview
        setName={data.style.name}
        cssVars={data.style.cssVars}
        darkCssVars={data.style.darkCssVars}
        {mode}
        {headline}
        {body}
        {cta}
      />
    </section>
  {/if}
</div>
