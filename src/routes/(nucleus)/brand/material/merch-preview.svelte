<script lang="ts">
  import type { MaterialFormat } from './formats'
  import MaterialCanvas from './material-canvas.svelte'
  import MaterialMark from './material-mark.svelte'

  /**
   * A merch print area (T-shirt front, mug wrap, tote) in the active style:
   * the brand mark and one slogan — merch carries no body copy or button.
   */
  let {
    setName,
    cssVars,
    darkCssVars,
    mode,
    format,
    headline,
  }: {
    setName: string
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
    mode: 'light' | 'dark'
    format: MaterialFormat
    headline: string
  } = $props()

  const landscape = $derived(format.width > format.height)
</script>

<MaterialCanvas
  {cssVars}
  {darkCssVars}
  {mode}
  {format}
  testid="merch"
  class={landscape
    ? 'items-center justify-center gap-6 p-6'
    : 'max-w-sm flex-col items-center justify-center gap-5 p-8 text-center'}
>
  <span class="size-12 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
  <div class={landscape ? 'flex min-w-0 flex-col gap-2' : 'flex flex-col items-center gap-3'}>
    <h3 class="font-display text-3xl leading-tight break-words">{headline}</h3>
    <div class="h-1.5 w-16 rounded-full bg-accent" aria-hidden="true"></div>
    <MaterialMark {setName} />
  </div>
</MaterialCanvas>
