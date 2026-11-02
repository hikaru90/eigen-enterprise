<script lang="ts">
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { activeMemorySurfaceTab, MEMORY_TABS } from '$lib/memory/memory-surface-nav'

  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const current = $derived(activeMemorySurfaceTab(page.url.pathname))
</script>

<!-- The Memory module page: one header with status, one sub-navigation. -->
<div class="flex min-h-0 w-full flex-1 flex-col" data-testid="memory-page">
  <header class="mx-auto w-full max-w-5xl px-4 pt-6 sm:px-8 sm:pt-10">
    <div class="flex min-w-0 items-center gap-3">
      <h1 class="min-w-0 truncate text-xl font-semibold tracking-tight">{data.memory.name}</h1>
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium {data
          .memory.active
          ? 'text-foreground'
          : 'text-muted-foreground'}"
        data-testid="module-status"
      >
        <span
          class="size-1.5 rounded-full {data.memory.active
            ? 'bg-primary'
            : 'bg-muted-foreground/40'}"
          aria-hidden="true"
        ></span>
        {data.memory.active ? 'Active' : 'Not active'}
      </span>
    </div>
    <p class="mt-1.5 text-sm text-muted-foreground">
      Tasks, projects and notes you and the agent keep — and a place to capture a thought.
    </p>
    <nav
      class="mt-5 -mb-px flex gap-1 overflow-x-auto border-b border-border"
      aria-label="Memory sections"
      data-testid="memory-nav"
    >
      {#each MEMORY_TABS as tab (tab.id)}
        <a
          href={resolve(tab.href)}
          aria-current={current === tab.id ? 'page' : undefined}
          data-testid="memory-tab-{tab.id}"
          class="-mb-px shrink-0 border-b-2 px-2.5 py-2.5 text-[13px] whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring/60 {current ===
          tab.id
            ? 'border-foreground font-medium text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}">{tab.label}</a
        >
      {/each}
    </nav>
  </header>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    {@render children()}
  </div>
</div>
