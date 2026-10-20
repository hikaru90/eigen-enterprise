<script lang="ts">
  import type { ModuleOverview } from '$lib/server/overview/overview'

  let { module }: { module: ModuleOverview } = $props()
</script>

<section
  class="min-w-0 rounded-sm border border-black/15 bg-white px-3 py-3 text-black"
  data-testid="overview-module"
>
  <div class="flex items-baseline justify-between gap-3">
    <h2 class="min-w-0 truncate text-sm font-medium">{module.name}</h2>
    <span
      class={module.active
        ? 'shrink-0 text-[11px] font-medium tracking-[0.2em] text-black uppercase'
        : 'shrink-0 text-[11px] font-medium tracking-[0.2em] text-black/40 uppercase'}
      data-testid="overview-module-state">{module.active ? 'Active' : 'Inactive'}</span
    >
  </div>
  <p class="mt-0.5 line-clamp-1 text-xs text-black/50" title={module.description}>
    {module.description}
  </p>

  {#if module.active && (module.results.length > 0 || module.note)}
    <p class="mt-3 text-[11px] font-medium tracking-[0.2em] text-black/60 uppercase">Results</p>
    <ul class="mt-1 divide-y divide-black/10">
      {#each module.results as result, i (i)}
        <li class="flex min-w-0 items-baseline justify-between gap-3 py-1.5 text-sm">
          {#if result.href}
            <a
              href={result.href}
              class="min-w-0 truncate underline underline-offset-2 hover:text-black/70"
              target="_blank"
              rel="external noopener noreferrer">{result.label}</a
            >
          {:else}
            <span class="min-w-0 truncate">{result.label}</span>
          {/if}
          {#if result.detail}
            <span class="shrink-0 text-xs text-black/50">{result.detail}</span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if module.note}
      <p class="mt-1 text-xs text-black/50" data-testid="overview-module-note">{module.note}</p>
    {/if}
  {/if}
</section>
