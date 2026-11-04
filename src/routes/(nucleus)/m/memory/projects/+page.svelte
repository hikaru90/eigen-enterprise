<script lang="ts">
  import type { PageData } from './$types'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import PinIcon from '@lucide/svelte/icons/pin'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { docTitle } from '$lib/shell/title'
  import TimelineShell from '../../../../timeline/timeline-shell.svelte'

  let { data }: { data: PageData } = $props()

  const initialEventId = $derived(page.url.searchParams.get('event'))
  const roadmap = $derived(data.roadmap)
</script>

<svelte:head><title>{docTitle('Projects', 'Memory')}</title></svelte:head>

<div class="flex min-h-[70dvh] flex-1 flex-col overflow-hidden overscroll-none">
  <!-- The company's Roadmap, pinned first for everyone (P-4). -->
  <div class="shrink-0 px-4 pt-4 sm:px-8">
    <a
      href={resolve('/m/memory/projects/roadmap')}
      class="group flex w-full flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3.5 transition-colors hover:bg-muted/50 sm:flex-row sm:items-center sm:gap-6"
      data-testid="project-card-roadmap"
    >
      <div class="flex min-w-0 items-center gap-2">
        <PinIcon class="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span class="text-sm font-medium text-foreground">Roadmap</span>
        <span
          class="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
          >System project</span
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
    </a>
  </div>
  <TimelineShell
    mode="projects"
    {initialEventId}
    prefetchedSource={data.prefetchedTimeline}
    prefetchedAuthorScope={data.prefetchedAuthorScope}
    userTimeZone={data.preferredTimezone}
    userName={data.user.name}
    eventNotificationsEnabled={data.eventNotificationsEnabled}
    eventReminderLeadMinutes={data.eventReminderLeadMinutes}
  />
</div>
