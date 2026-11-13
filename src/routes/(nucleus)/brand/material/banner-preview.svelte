<script lang="ts">
  import type { MaterialFormat } from './formats'
  import MaterialCanvas from './material-canvas.svelte'
  import MaterialCta from './material-cta.svelte'
  import MaterialMark from './material-mark.svelte'

  /**
   * A banner in the active style: a landscape social header (copy left, call
   * to action right) or a portrait roll-up for the booth (stacked, the
   * headline large at eye level).
   */
  let {
    setName,
    cssVars,
    darkCssVars,
    mode,
    format,
    headline,
    body,
    cta,
  }: {
    setName: string
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
    mode: 'light' | 'dark'
    format: MaterialFormat
    headline: string
    body: string
    cta: string
  } = $props()

  const landscape = $derived(format.width > format.height)
</script>

{#if landscape}
  <MaterialCanvas
    {cssVars}
    {darkCssVars}
    {mode}
    {format}
    testid="banner"
    class="items-center justify-between gap-6 p-6"
  >
    <div class="flex min-w-0 flex-col gap-2">
      <MaterialMark {setName} />
      <h3 class="font-display text-2xl leading-tight break-words">{headline}</h3>
      <p class="text-sm break-words text-foreground/75">{body}</p>
    </div>
    <div class="flex shrink-0 flex-col items-end gap-3">
      <MaterialCta {cta} />
      <div class="h-1.5 w-16 rounded-full bg-accent" aria-hidden="true"></div>
    </div>
  </MaterialCanvas>
{:else}
  <MaterialCanvas
    {cssVars}
    {darkCssVars}
    {mode}
    {format}
    testid="banner"
    class="max-w-56 flex-col justify-between p-6"
  >
    <header><MaterialMark {setName} /></header>
    <div class="flex flex-col gap-4">
      <h3 class="font-display text-3xl leading-tight break-words">{headline}</h3>
      <p class="text-sm break-words text-foreground/75">{body}</p>
      <MaterialCta {cta} />
    </div>
    <footer class="flex flex-col gap-2">
      <div class="h-16 w-full rounded-md bg-primary" aria-hidden="true"></div>
      <div class="h-1.5 w-full rounded-full bg-accent" aria-hidden="true"></div>
    </footer>
  </MaterialCanvas>
{/if}
