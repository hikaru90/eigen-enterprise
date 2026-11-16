<script lang="ts">
  import type { PageData } from './$types'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { browserActiveCall } from '$lib/calls/active-call.svelte'
  import { getCallPresence } from '$lib/calls/call-presence.svelte'
  import { callTabName, leaveDecision, openCallTab } from '$lib/calls/call-tab'
  import CallView from '$lib/calls/call-view.svelte'
  import { callsClient, problemOf } from '$lib/calls/client'
  import { docTitle } from '$lib/shell/title'

  /**
   * The call page is a call's own tab (call-tab.ts; owner, 2026-11-16: "a
   * call always opens in a separate tab, so the main instance is kept clean").
   * Full-screen, no app shell (page data `callTab`). This page owns the live
   * call (ActiveCall) and tells the other tabs about it (CallPresence).
   *
   * While I am in the call nothing navigates this tab away: an in-app
   * navigation is cancelled with "hang up first", and a reload / close asks
   * the browser's own "leave this page?" first. Hanging up closes the tab when
   * the app opened it; otherwise (an address typed in) the ended state stays
   * with a way back to /calls. A call that ended on its own (declined, missed,
   * over) says so and offers Close — the tab does not vanish under the person.
   */
  let { data }: { data: PageData } = $props()

  const presence = getCallPresence()
  const active = browserActiveCall(callsClient())

  /** The app opened this tab (window.open), so it may close it again. */
  let closable = $state(false)
  let notice = $state<string | null>(null)
  let untrack = () => {}

  onMount(() => {
    closable = window.opener !== null
    untrack = presence.track(active)
  })

  // Named after its call on every arrival, so Join / Accept elsewhere finds this tab.
  afterNavigate(() => {
    window.name = callTabName(data.call.id)
  })

  onDestroy(() => {
    untrack()
    active.close()
    if (typeof window !== 'undefined' && window.name.startsWith(callTabName(''))) window.name = ''
  })

  beforeNavigate((nav) => {
    const decision = leaveDecision(active.inCall, nav.willUnload)
    if (decision === 'allow') return
    // On an unload, cancelling makes the browser ask "leave this page?" itself.
    nav.cancel()
    if (decision === 'block') notice = "You're in a call. Hang up first to leave it."
  })

  function leave() {
    if (closable) window.close()
    else void goto(resolve('/calls'))
  }

  function hungUp() {
    if (closable) window.close()
  }

  function openOther(callId: string) {
    try {
      openCallTab(callId)
    } catch (err) {
      notice = problemOf(err).message
    }
  }
</script>

<svelte:head><title>{docTitle(data.call.title, 'Calls')}</title></svelte:head>

<div class="relative flex h-dvh flex-col" data-testid="call-tab">
  {#if notice}
    <div
      class="absolute inset-x-2 top-16 z-30 mx-auto flex max-w-md items-start gap-2 rounded-lg border border-amber-400/30 bg-neutral-900/95 p-3 text-sm text-neutral-50 shadow-lg"
      role="alert"
      data-testid="call-tab-notice"
    >
      <p class="min-w-0 flex-1">{notice}</p>
      <button type="button" class="text-neutral-400 hover:text-white" aria-label="Dismiss" onclick={() => (notice = null)}><X class="size-4" /></button>
    </div>
  {/if}
  {#key data.call.id}
    <CallView
      {active}
      call={data.call}
      me={data.me}
      leaveLabel={closable ? 'Close' : 'Back to calls'}
      onleave={leave}
      onhungup={hungUp}
      onopen={openOther}
    />
  {/key}
</div>
