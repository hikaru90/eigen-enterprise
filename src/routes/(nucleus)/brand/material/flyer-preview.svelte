<script lang="ts">
  import { cn } from '$lib/utils.js'
  import {
    SYSTEM_SCOPE_ATTR,
    systemScopeCss,
  } from '../../../../../modules/brand/system/component-set'

  /**
   * A digital flyer (A5 portrait) rendered from the active visual set's tokens
   * through the same scope emitter the design system view uses — no new
   * generation path. The copy is the owner's own words.
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

  const scopeCss = $derived(systemScopeCss(cssVars, darkCssVars))
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- emitter output over the owner-approved active visual set tokens -->
{@html `<style>\n${scopeCss}</style>`}
<article
  {...{ [SYSTEM_SCOPE_ATTR]: mode }}
  class={cn(
    'flex aspect-[148/210] w-full max-w-md flex-col justify-between overflow-hidden rounded-lg border border-border bg-background p-8 font-sans text-foreground shadow-md',
    mode === 'dark' && 'dark',
  )}
  data-testid="flyer"
>
  <header class="flex items-center gap-2">
    <span class="size-3 rounded-full bg-primary" aria-hidden="true"></span>
    <span class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{setName}</span>
  </header>
  <div class="flex flex-col gap-4">
    <h3 class="font-display text-4xl leading-tight break-words">{headline}</h3>
    <p class="text-base break-words text-foreground/75">{body}</p>
  </div>
  <footer class="flex flex-col gap-3">
    <span
      class="inline-flex w-fit rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
      >{cta}</span
    >
    <div class="h-1.5 w-full rounded-full bg-accent" aria-hidden="true"></div>
  </footer>
</article>
