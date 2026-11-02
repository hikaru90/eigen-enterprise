<script lang="ts">
  import type { PageData } from './$types'
  import { page } from '$app/state'
  import TimelineShell from '../../../timeline/timeline-shell.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()

  const initialEventId = $derived(page.url.searchParams.get('event'))
</script>

<svelte:head><title>{docTitle('Projects', 'Memory')}</title></svelte:head>

<div class="-mb-28 flex h-dvh flex-col overflow-hidden overscroll-none">
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
