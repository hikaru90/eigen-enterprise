<script lang="ts">
  import { socialFormat, type SocialFormatId, type SocialGraphic } from '../../../../../modules/brand/social/types'
  import MaterialCanvas from '../material/material-canvas.svelte'

  /**
   * A social post's branded graphic in the active style: Material's canvas
   * (the visual set's tokens through the design-system scope emitter) at the
   * post's social aspect ratio. Type is sized in container units so a card
   * thumbnail and the full preview show the same composition — the PNG export
   * (social-export.ts) draws it with the same proportions.
   */
  let {
    setName,
    cssVars,
    darkCssVars,
    format,
    graphic,
    testid = 'social-graphic',
    root = $bindable(null),
  }: {
    setName: string
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
    format: SocialFormatId
    graphic: SocialGraphic
    testid?: string
    root?: HTMLElement | null
  } = $props()

  const f = $derived(socialFormat(format))
  const landscape = $derived(f.width > f.height)
  // Container-width units (cqw) of the drawn width; shared with the export.
  const headlineSize = $derived(landscape ? 5.5 : 7.5)
</script>

<div class="w-full" style="container-type: inline-size" bind:this={root}>
  <MaterialCanvas
    {cssVars}
    {darkCssVars}
    mode={graphic.mode}
    format={f}
    {testid}
    class="flex-col justify-between"
  >
    <div class="flex h-full flex-col justify-between" style="padding: 7cqw">
      <span class="flex items-center" style="gap: 1.6cqw">
        <span class="shrink-0 rounded-full bg-primary" style="width: 2.2cqw; height: 2.2cqw" data-part="mark" aria-hidden="true"></span>
        <span class="font-medium tracking-wide text-muted-foreground uppercase" style="font-size: 2.4cqw" data-part="name">{setName}</span>
      </span>
      <div class="flex flex-col" style="gap: 3cqw">
        <h3 class="font-display leading-tight break-words" style="font-size: {headlineSize}cqw" data-part="headline">{graphic.headline}</h3>
        {#if graphic.body}
          <p class="break-words text-foreground/75" style="font-size: 3.6cqw; line-height: 1.4" data-part="body">{graphic.body}</p>
        {/if}
        {#if graphic.cta}
          <span
            class="inline-flex w-fit rounded-md bg-primary font-medium text-primary-foreground"
            style="font-size: 3.2cqw; padding: 1.8cqw 3.6cqw"
            data-part="cta">{graphic.cta}</span
          >
        {/if}
        <span class="block rounded-full bg-accent" style="height: 1cqw; width: 14cqw" data-part="accent" aria-hidden="true"></span>
      </div>
    </div>
  </MaterialCanvas>
</div>
