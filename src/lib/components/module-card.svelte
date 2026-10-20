<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import { appHref } from '$lib/shell/href'
  import type { ModuleOverview } from '$lib/server/overview/overview'
  import { moduleHref } from '$lib/shell/nav'

  /** A dashboard card for one active module: status dot, key counts, link to its page. */
  let { module }: { module: ModuleOverview } = $props()
</script>

<a
  href={appHref(moduleHref(module.id))}
  class="group flex min-w-0 flex-col rounded-lg border border-border bg-background p-4 transition-[border-color,box-shadow] outline-none hover:border-foreground/20 hover:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_4px_12px_rgb(0_0_0/0.04)] focus-visible:ring-2 focus-visible:ring-ring/60"
  data-testid="module-card"
>
  <div class="flex min-w-0 items-center gap-2">
    <span
      class="size-2 shrink-0 rounded-full {module.active ? 'bg-eigen-green' : 'bg-foreground/20'}"
      aria-hidden="true"
    ></span>
    <h3 class="min-w-0 flex-1 truncate text-sm font-medium">{module.name}</h3>
    <ChevronRight
      class="size-4 shrink-0 text-foreground/30 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground/60"
      aria-hidden="true"
    />
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
</a>
