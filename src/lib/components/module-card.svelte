<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import type { Pathname } from '$app/types'
  import type { ModuleOverview } from '$lib/server/overview/overview'
  import { appHref } from '$lib/shell/href'
  import { iconFor } from '$lib/shell/module-icon'
  import { hasGrain, toneOf } from '$lib/shell/module-tone'

  /**
   * A dashboard card for one active module: status dot, key counts, link to
   * its page. `href` is the module's page as the nav lists it for this
   * person; null = a page they can't open (e.g. Website for a member), so the
   * card shows the module but is no link — never a way into a 403.
   */
  let { module, href }: { module: ModuleOverview; href: Pathname | null } = $props()

  // The part's colour and icon, as the website shows it (module-tone.ts).
  const tone = $derived(toneOf(module.id))
  const Icon = $derived(iconFor(module.id))
</script>

<svelte:element
  this={href ? 'a' : 'div'}
  href={href ? appHref(href) : undefined}
  class="tile tile-{tone} group flex min-h-56 min-w-0 flex-col p-6 outline-none {hasGrain(tone) ? 'grain' : ''} {href
    ? 'transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
    : ''}"
  data-testid="module-card"
>
  <div class="flex min-w-0 items-center justify-between gap-2">
    <span class="ico {tone === 'black' || tone === 'blue' || tone === 'violet' ? 'ico-white' : 'ico-black'}" aria-hidden="true">
      <Icon class="size-4" strokeWidth={1.75} />
    </span>
    <span class="chip chip-line chip-dot {module.active ? '' : 'chip-off'}">{module.active ? 'On' : 'Off'}</span>
  </div>
  <h3 class="display-m mt-auto flex min-w-0 items-center gap-2 pt-8">
    <span class="min-w-0 truncate">{module.name}</span>
    {#if href}
      <ArrowUpRight
        class="size-5 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
        aria-hidden="true"
      />
    {/if}
  </h3>
  <p class="tile-soft mt-2 line-clamp-2 text-sm leading-relaxed">{module.description}</p>
  {#if module.counts.length > 0}
    <dl class="mt-4 flex flex-wrap gap-2">
      {#each module.counts as count (count.label)}
        <div class="chip chip-wash min-w-0">
          <dt>{count.label}</dt>
          <dd class="font-medium" data-testid="module-card-count-{count.label}">{count.value}</dd>
        </div>
      {/each}
    </dl>
  {:else if module.note}
    <p class="tile-soft mt-4 text-sm">{module.note}</p>
  {:else if module.results.length > 0}
    <p class="mt-4 truncate text-sm">
      {module.results[0].label}{#if module.results[0].detail}<span class="tile-soft">
          · {module.results[0].detail}</span
        >{/if}
    </p>
  {/if}
</svelte:element>
