<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import type { Pathname } from '$app/types'
  import type { ModuleOverview } from '$lib/server/overview/overview'
  import { appHref } from '$lib/shell/href'

  /**
   * A dashboard card for one active module: status dot, key counts, link to
   * its page. `href` is the module's page as the nav lists it for this
   * person; null = a page they can't open (e.g. Website for a member), so the
   * card shows the module but is no link — never a way into a 403.
   */
  let { module, href }: { module: ModuleOverview; href: Pathname | null } = $props()
</script>

<svelte:element
  this={href ? 'a' : 'div'}
  href={href ? appHref(href) : undefined}
  class="group flex min-w-0 flex-col rounded-lg border border-border bg-background p-4 outline-none {href
    ? 'transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_rgb(0_0_0/0.04)] focus-visible:ring-2 focus-visible:ring-ring/60'
    : ''}"
  data-testid="module-card"
>
  <div class="flex min-w-0 items-center gap-2">
    <span
      class="size-2 shrink-0 rounded-full {module.active ? 'bg-eigen-green' : 'bg-foreground/20'}"
      aria-hidden="true"
    ></span>
    <h3 class="min-w-0 flex-1 truncate text-sm font-medium">{module.name}</h3>
    {#if href}
      <ChevronRight
        class="size-4 shrink-0 text-foreground/30 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground/60"
        aria-hidden="true"
      />
    {/if}
  </div>
  <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/55">{module.description}</p>
  {#if module.counts.length > 0}
    <dl class="mt-4 flex flex-wrap gap-x-6 gap-y-2">
      {#each module.counts as count (count.label)}
        <div class="min-w-0">
          <dt class="text-[11px] text-foreground/45">{count.label}</dt>
          <dd
            class="text-lg font-semibold tabular-nums leading-tight"
            data-testid="module-card-count-{count.label}"
          >
            {count.value}
          </dd>
        </div>
      {/each}
    </dl>
  {:else if module.note}
    <p class="mt-4 text-xs text-foreground/55">{module.note}</p>
  {:else if module.results.length > 0}
    <p class="mt-4 truncate text-xs text-foreground/70">
      {module.results[0].label}{#if module.results[0].detail}<span class="text-foreground/45">
          · {module.results[0].detail}</span
        >{/if}
    </p>
  {/if}
</svelte:element>
