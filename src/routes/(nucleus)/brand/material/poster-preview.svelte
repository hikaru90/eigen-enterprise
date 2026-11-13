<script lang="ts">
  import type { MaterialFormat } from './formats'
  import MaterialCanvas from './material-canvas.svelte'
  import MaterialCta from './material-cta.svelte'
  import MaterialMark from './material-mark.svelte'

  /**
   * A trade-show poster (A-series portrait) in the active style: a primary
   * colour field carries the headline so it reads from across the hall.
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
</script>

<MaterialCanvas {cssVars} {darkCssVars} {mode} {format} testid="poster" class="max-w-md flex-col">
  <div class="flex flex-1 flex-col justify-between gap-6 bg-primary p-8 text-primary-foreground">
    <span class="flex items-center gap-2">
      <span class="size-3 rounded-full bg-primary-foreground" aria-hidden="true"></span>
      <span class="text-xs font-medium tracking-wide uppercase">{setName}</span>
    </span>
    <h3 class="font-display text-5xl leading-none break-words">{headline}</h3>
  </div>
  <div class="flex flex-col gap-4 p-8">
    <p class="text-base break-words text-foreground/75">{body}</p>
    <div class="flex items-center justify-between gap-4">
      <MaterialCta {cta} />
      <MaterialMark {setName} />
    </div>
    <div class="h-1.5 w-full rounded-full bg-accent" aria-hidden="true"></div>
  </div>
</MaterialCanvas>
