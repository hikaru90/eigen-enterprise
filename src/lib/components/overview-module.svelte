<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import type { ModuleOverview } from '$lib/server/overview/overview'

  /** A module's results list (used on /m/[id]): state, results, and the note when results can't be shown. */
  let { module }: { module: ModuleOverview } = $props()
</script>

<section class="min-w-0" data-testid="overview-module">
  <p class="sr-only" data-testid="overview-module-state">{module.active ? 'Active' : 'Inactive'}</p>
  {#if module.active && (module.results.length > 0 || module.note)}
    <h2 class="text-[13px] font-medium text-foreground">{module.resultsTitle}</h2>
    {#if module.results.length > 0}
      <ul class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
        {#each module.results as result, i (i)}
          <li class="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5 text-sm">
            {#if result.href}
              <a
                href={result.href}
                class="group inline-flex min-w-0 items-center gap-1 rounded-sm outline-none hover:underline hover:underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring/60"
                target="_blank"
                rel="external noopener noreferrer"
                ><span class="truncate">{result.label}</span><ArrowUpRight
                  class="size-3.5 shrink-0 text-foreground/35 group-hover:text-foreground/70"
                  aria-hidden="true"
                /></a
              >
            {:else}
              <span class="min-w-0 truncate">{result.label}</span>
            {/if}
            {#if result.detail}
              <span class="shrink-0 text-xs text-foreground/55">{result.detail}</span>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if module.note}
      <p class="mt-2 text-xs text-foreground/55" data-testid="overview-module-note">
        {module.note}
      </p>
    {/if}
  {/if}
</section>
