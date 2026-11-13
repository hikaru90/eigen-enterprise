<script lang="ts">
  import type { MaterialFormat } from './formats'
  import type { Snippet } from 'svelte'
  import { cn } from '$lib/utils.js'
  import {
    SYSTEM_SCOPE_ATTR,
    systemScopeCss,
  } from '../../../../../modules/brand/system/component-set'

  /**
   * The surface every brand-material preview draws on: the active visual set's
   * tokens through the same scope emitter the design system view uses (no new
   * generation path), at the format's true aspect ratio.
   */
  let {
    cssVars,
    darkCssVars,
    mode,
    format,
    testid,
    class: className,
    children,
  }: {
    cssVars: Record<string, string>
    darkCssVars: Record<string, string> | null
    mode: 'light' | 'dark'
    format: MaterialFormat
    testid: string
    class?: string
    children: Snippet
  } = $props()

  const scopeCss = $derived(systemScopeCss(cssVars, darkCssVars))
</script>

<!-- eslint-disable-next-line svelte/no-at-html-tags -- emitter output over the owner-approved active visual set tokens -->
{@html `<style>\n${scopeCss}</style>`}
<article
  {...{ [SYSTEM_SCOPE_ATTR]: mode }}
  class={cn(
    'flex w-full overflow-hidden rounded-lg border border-border bg-background font-sans text-foreground shadow-md',
    mode === 'dark' && 'dark',
    className,
  )}
  style:aspect-ratio="{format.width} / {format.height}"
  data-format={format.id}
  data-testid={testid}
>
  {@render children()}
</article>
