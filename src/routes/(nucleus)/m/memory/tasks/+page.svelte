<script lang="ts">
  import type { ActionData, PageData } from './$types'
  import { page } from '$app/state'
  import { docTitle } from '$lib/shell/title'
  import TimelineShell from '../../../../timeline/timeline-shell.svelte'
  import AssignedTasks from './assigned-tasks.svelte'

  let { data, form }: { data: PageData; form: ActionData } = $props()

  const initialEventId = $derived(page.url.searchParams.get('event'))
  const formMessage = $derived(form && 'message' in form && typeof form.message === 'string' ? { taskId: form.taskId, message: form.message } : null)
  const hasAssigned = $derived(data.assigned.assignedToMe.length + data.assigned.assignedByMe.length > 0)
</script>

<svelte:head><title>{docTitle('Tasks', 'Memory')}</title></svelte:head>

{#if hasAssigned}
  <!-- Tasks assigned between members: shared with one colleague, not part of your private Memory. -->
  <div class="max-h-[45dvh] w-full shrink-0 overflow-y-auto px-4 pt-4 sm:px-8">
    <AssignedTasks assigned={data.assigned} {formMessage} />
  </div>
{/if}
<div class="flex min-h-[70dvh] flex-1 flex-col overflow-hidden overscroll-none">
  <TimelineShell
    mode="tasks"
    {initialEventId}
    prefetchedSource={data.prefetchedTimeline}
    prefetchedAuthorScope={data.prefetchedAuthorScope}
    userTimeZone={data.preferredTimezone}
    userName={data.user.name}
    eventNotificationsEnabled={data.eventNotificationsEnabled}
    eventReminderLeadMinutes={data.eventReminderLeadMinutes}
    initialSegment={page.url.searchParams.get('segment') === 'overdue' ? 'overdue' : null}
  />
</div>
