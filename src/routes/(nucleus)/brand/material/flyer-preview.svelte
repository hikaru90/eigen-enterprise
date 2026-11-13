<script lang="ts">
  import { formatById } from './formats'
  import MaterialCanvas from './material-canvas.svelte'
  import MaterialCta from './material-cta.svelte'
  import MaterialMark from './material-mark.svelte'

  /**
   * A digital flyer (A5 portrait) rendered from the active visual set's tokens.
   * The copy is the owner's own words.
   */
  let {
    setName,
    cssVars,
    darkCssVars,
    mode,
    headline,
    body,
    cta,
  }: {
    setName: string
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
    mode: 'light' | 'dark'
    headline: string
    body: string
    cta: string
  } = $props()

  const format = formatById('flyer-a5')
</script>

<MaterialCanvas
  {cssVars}
  {darkCssVars}
  {mode}
  {format}
  testid="flyer"
  class="max-w-md flex-col justify-between p-8"
>
  <header><MaterialMark {setName} /></header>
  <div class="flex flex-col gap-4">
    <h3 class="font-display text-4xl leading-tight break-words">{headline}</h3>
    <p class="text-base break-words text-foreground/75">{body}</p>
  </div>
  <footer class="flex flex-col gap-3">
    <MaterialCta {cta} />
    <div class="h-1.5 w-full rounded-full bg-accent" aria-hidden="true"></div>
  </footer>
</MaterialCanvas>
