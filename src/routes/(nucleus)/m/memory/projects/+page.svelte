<script lang="ts">
  import type { PageData } from './$types'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import MemoryScopeTabs, { type MemoryScope } from '$lib/components/memory-scope-tabs.svelte'
  import { docTitle } from '$lib/shell/title'
  import TimelineShell from '../../../../timeline/timeline-shell.svelte'
  import RoadmapPinnedCard from './roadmap-pinned-card.svelte'
  import TeamProjectsList from './team-projects-list.svelte'

  let { data }: { data: PageData } = $props()

  const initialEventId = $derived(page.url.searchParams.get('event'))

  /** Mine / Team is view state in the URL (?scope=team); the server loads Team. */
  async function selectScope(next: MemoryScope) {
    await goto(resolve(next === 'team' ? '/m/memory/projects?scope=team' : '/m/memory/projects'), {
      noScroll: true,
      keepFocus: true,
    })
  }
</script>

<svelte:head><title>{docTitle('Projects', 'Memory')}</title></svelte:head>

<div class="flex min-h-[70dvh] flex-1 flex-col overflow-hidden overscroll-none">
  <!-- The company's Roadmap, pinned first for everyone (P-4). -->
  <div class="shrink-0 space-y-3 px-4 pt-4 sm:px-8">
    <RoadmapPinnedCard roadmap={data.roadmap} />
    <MemoryScopeTabs scope={data.scope} onselect={(next) => void selectScope(next)} />
  </div>
  {#if data.scope === 'team'}
    <div class="flex min-h-0 flex-1 flex-col pt-3 sm:px-5">
      <TeamProjectsList projects={data.teamProjects} />
    </div>
  {:else}
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
  {/if}
</div>
