<script lang="ts">
  import type { PageData } from './$types'
  import X from '@lucide/svelte/icons/x'
  import { onDestroy, onMount } from 'svelte'
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { browserActiveCall } from '$lib/calls/active-call.svelte'
  import { CallBrain } from '$lib/calls/call-brain.svelte'
  import { getCallPresence } from '$lib/calls/call-presence.svelte'
  import { callTabName, leaveDecision, openCallTab } from '$lib/calls/call-tab'
  import { browserCallTranscription } from '$lib/calls/call-transcription.svelte'
  import CallView from '$lib/calls/call-view.svelte'
  import { brainClient, callsClient, shownProblemOf } from '$lib/calls/client'
  import { getLiveCalls } from '$lib/calls/live-calls.svelte'
  import { recapImportHref } from '$lib/calls/recap-import'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import type { ShownError } from '$lib/errors/agent-report'
  import { docTitle } from '$lib/shell/title'
  import { TRANSCRIPT_CHUNK_MS } from '../../../../../modules/calls/transcript'

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
   *
   * The call feed (the nucleus layout's) keeps the call's view current — its
   * answer time (the clock) and who is transcribed. This page also owns the
   * transcription of my microphone (CallTranscription), connected on mount.
   */
  let { data }: { data: PageData } = $props()

  const presence = getCallPresence()
  const liveCalls = getLiveCalls()
  const client = callsClient()
  const active = browserActiveCall(client)
  // svelte-ignore state_referenced_locally
  const transcription = browserCallTranscription(active, data.me, client, TRANSCRIPT_CHUNK_MS)
  // The Company Brain (members only): off until someone in the call switches it on; it answers only when asked.
  const brainApi = brainClient()
  // svelte-ignore state_referenced_locally
  const brain = new CallBrain({ active, me: data.me, client: brainApi })

  /** The app opened this tab (window.open), so it may close it again. */
  let closable = $state(false)
  let notice = $state<string | null>(null)
  /** Opening the other call's tab failed (e.g. the browser blocked it). */
  let openError = $state<ShownError | null>(null)
  let untrack = () => {}
  let unfeed = () => {}

  /** The feed's newest view of this call (it leaves the feed once over: the ended view needs nothing more). */
  function fromFeed() {
    const c = liveCalls.calls.find((x) => x.id === data.call.id)
    if (c) active.update(c)
  }

  onMount(() => {
    closable = window.opener !== null
    untrack = presence.track(active)
    transcription.connect()
    unfeed = liveCalls.subscribe(fromFeed)
  })

  // Named after its call on every arrival, so Join / Accept elsewhere finds this tab.
  afterNavigate(() => {
    window.name = callTabName(data.call.id)
  })

  onDestroy(() => {
    untrack()
    unfeed()
    active.close()
    transcription.close()
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
      openError = shownProblemOf(err)
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
      <button
        type="button"
        class="text-neutral-400 hover:text-white"
        aria-label="Dismiss"
        onclick={() => (notice = null)}><X class="size-4" /></button
      >
    </div>
  {/if}
  {#if openError}
    <div
      class="absolute inset-x-2 top-16 z-30 mx-auto flex max-w-md items-start gap-2 rounded-lg border border-amber-400/30 bg-neutral-900/95 p-3 text-sm text-neutral-50 shadow-lg"
      data-testid="call-tab-open-error"
    >
      <ErrorNotice
        class="min-w-0 flex-1"
        error={openError.error}
        agent={openError.agent}
        attempted="Opening another call's tab from a call"
      />
      <button
        type="button"
        class="text-neutral-400 hover:text-white"
        aria-label="Dismiss"
        onclick={() => (openError = null)}><X class="size-4" /></button
      >
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
      {transcription}
      {brain}
      brainRecap={brainApi}
      recapImportHref={data.shell?.assistant === true ? recapImportHref('/', data.call) : null}
      transcriptHref={resolve('/(nucleus)/calls/[id]/transcript', { id: data.call.id })}
    />
  {/key}
</div>
