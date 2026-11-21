<script lang="ts">
  import type { PageData } from './$types'
  import { page } from '$app/state'
  import { docTitle } from '$lib/shell/title'
  import TimelineShell from '../../../../timeline/timeline-shell.svelte'
  import RoadmapPinnedCard from './roadmap-pinned-card.svelte'

  let { data }: { data: PageData } = $props()

  const initialEventId = $derived(page.url.searchParams.get('event'))
</script>

<svelte:head><title>{docTitle('Projects', 'Memory')}</title></svelte:head>

<div class="flex min-h-[70dvh] flex-1 flex-col overflow-hidden overscroll-none">
  <!-- The company's Roadmap, pinned first for everyone (P-4). -->
  <div class="shrink-0 px-4 pt-4 sm:px-8">
    <RoadmapPinnedCard roadmap={data.roadmap} />
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
