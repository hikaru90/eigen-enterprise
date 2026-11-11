<script lang="ts">
  import type { PageData } from './$types'
  import { onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import CallView from '$lib/calls/call-view.svelte'
  import { callsClient } from '$lib/calls/client'
  import type { CallRoom } from '$lib/calls/room'
  import { docTitle } from '$lib/shell/title'

  /**
   * The call page (plan/video-calls.md §3). livekit-client is loaded in the
   * browser only (it needs WebRTC), then CallView joins the call.
   */
  let { data }: { data: PageData } = $props()

  const client = callsClient()
  let createRoom = $state<(() => CallRoom) | null>(null)
  let loadError = $state<string | null>(null)

  onMount(() => {
    import('$lib/calls/livekit-room')
      .then((m) => (createRoom = m.createLiveKitRoom))
      .catch((err: unknown) => (loadError = `The call could not load (${err instanceof Error ? err.message : String(err)}). Reload the page.`))
  })
</script>

<svelte:head><title>{docTitle(data.call.title, 'Calls')}</title></svelte:head>

{#if createRoom}
  {#key data.call.id}
    <CallView call={data.call} me={data.me} {client} {createRoom} onleave={() => goto(resolve('/calls'))} />
  {/key}
{:else}
  <div class="grid h-full min-h-0 w-full flex-1 place-items-center bg-neutral-950 p-6 text-center text-sm text-neutral-300" data-testid="call-loading">
    {#if loadError}<p role="alert">{loadError}</p>{:else}<p>Connecting…</p>{/if}
  </div>
{/if}
