<script lang="ts">
  import type { RoadmapSummary } from '../../../../../../modules/orchestrator/roadmap/summary'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import PinIcon from '@lucide/svelte/icons/pin'
  import { resolve } from '$app/paths'

  /**
   * Memory › Projects: the company's Roadmap, pinned first for everyone (P-4).
   * It says in place what it is and why it is pinned (Contribute 6b5eda9f):
   * the one system project the whole company shares, so it cannot be unpinned
   * — there is no unpin, by design.
   */
  let { roadmap }: { roadmap: RoadmapSummary } = $props()
</script>

<a
  href={resolve('/m/memory/projects/roadmap')}
  class="group flex w-full flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 transition-colors outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
  data-testid="project-card-roadmap"
>
  <div class="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
    <div class="flex min-w-0 items-center gap-2">
      <PinIcon class="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span class="text-sm font-medium text-foreground">Roadmap</span>
      <span class="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground"
        >Pinned · System project</span
      >
    </div>
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground tabular-nums"
    >
      <span>{roadmap.planned} planned</span>
      <span>{roadmap.inProgress} in progress</span>
      <span>{roadmap.shipped} shipped</span>
    </div>
    {#if roadmap.building.length > 0}
      <p class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        Building: {roadmap.building.join(' · ')}
      </p>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <ChevronRightIcon
      class="hidden size-4 shrink-0 text-muted-foreground group-hover:text-foreground sm:block"
      aria-hidden="true"
    />
  </div>
  <p class="max-w-[65ch] text-xs text-muted-foreground" data-testid="roadmap-card-purpose">
    The company's plan: what is planned, being built and shipped. Pinned for everyone because it is
    the one project the whole company shares; it can't be unpinned.
  </p>
</a>
