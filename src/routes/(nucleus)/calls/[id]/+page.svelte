<script lang="ts">
  import type { PageData } from './$types'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { getActiveCall } from '$lib/calls/active-call.svelte'
  import CallView from '$lib/calls/call-view.svelte'
  import { docTitle } from '$lib/shell/title'

  /**
   * The call page (plan/video-calls.md §3). The live call belongs to the
   * nucleus layout (ActiveCall): this page shows it, and leaving the page
   * keeps the call — the docked mini call takes over.
   */
  let { data }: { data: PageData } = $props()

  const active = getActiveCall()
</script>

<svelte:head><title>{docTitle(data.call.title, 'Calls')}</title></svelte:head>

{#key data.call.id}
  <CallView
    {active}
    call={data.call}
    me={data.me}
    onleave={() => goto(resolve('/calls'))}
    onopen={(id) => goto(resolve(`/calls/${id}`))}
  />
{/key}
