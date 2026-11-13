<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { browserActiveCall, setActiveCall } from '$lib/calls/active-call.svelte'
  import { callsClient } from '$lib/calls/client'
  import IncomingCallToast from '$lib/calls/incoming-call-toast.svelte'
  import { LiveCalls, setLiveCalls } from '$lib/calls/live-calls.svelte'
  import MiniCall from '$lib/calls/mini-call.svelte'
  import AppShell from '$lib/components/app-shell.svelte'
  import { PresenceHeartbeat } from '$lib/messages/presence'
  import { SelfPresence, setSelfPresence } from '$lib/messages/self-presence.svelte'
  import { shellVisible } from '$lib/shell/nav'

  let { data, children } = $props()

  // Ring everywhere (plan/video-calls.md owner decision 5): one call feed for
  // every nucleus page — opened here on mount, closed on destroy — feeding the
  // incoming-call toast and the Messages call button.
  const liveCalls = setLiveCalls(new LiveCalls())
  const calls = callsClient()
  // The live call lives here, above the pages: moving around the app keeps it.
  const activeCall = setActiveCall(browserActiveCall(calls))
  const resume = () => liveCalls.resume()
  const onVisible = () => {
    if (document.visibilityState === 'visible') resume()
  }

  // Presence (plan/contribute-round-3.md W5): this tab beats on every
  // nucleus page, not only in Messages — someone elsewhere in the app is
  // still online. Started on mount, stopped on destroy; no effects.
  // Each beat answers my own status, which the nav shows on every page
  // (Contribute e4ef6be1). Only while Messages, which owns presence, is on:
  // off means off — no beat, no status (round 4 W7).
  let presenceBeat: PresenceHeartbeat | null = null
  // Page data of the first load decides, like the beat: a switch takes effect on the next full load.
  // svelte-ignore state_referenced_locally
  const selfPresence = setSelfPresence(
    data.user && data.liveFeeds?.presence ? new SelfPresence({ fetch: (input, init) => fetch(input, init) }) : null,
  )

  onMount(() => {
    if (!data.user) return
    // Only for plugins that are on: the plugin gate answers 409 otherwise, and
    // a feed would retry forever. A switch takes effect on the next full load.
    if (data.liveFeeds?.calls) {
      liveCalls.connect(() => new EventSource('/api/calls/stream'))
      window.addEventListener('online', resume)
      document.addEventListener('visibilitychange', onVisible)
    }
    if (selfPresence) {
      presenceBeat = new PresenceHeartbeat({
        clientId: crypto.randomUUID(),
        post: selfPresence.beat,
        doc: document,
        win: window,
        now: () => Date.now(),
      })
      presenceBeat.start()
    }
  })

  onDestroy(() => {
    liveCalls.close()
    activeCall.close()
    presenceBeat?.stop()
    if (typeof window === 'undefined') return
    window.removeEventListener('online', resume)
    document.removeEventListener('visibilitychange', onVisible)
  })

  // Decided from page data, no effect: the welcome tour and the first-run
  // provider gate on / set showWelcome / needsOnboarding and run full-screen.
  const pageFlags = $derived(page.data as { showWelcome?: boolean; needsOnboarding?: boolean })
  const withShell = $derived(shellVisible({ shell: data.shell, ...pageFlags }))
  // B4: with an active visual set the nucleus consumes the brand tokens (the
  // root :root/.dark override). The light pin + bg-white only apply to the
  // app's own default style — otherwise they would shadow every brand token.
  const brandActive = $derived(Boolean(page.data.activeVisualSet))
</script>

<svelte:head>
  <title>eigenEnterprise</title>
</svelte:head>

<!--
  The nucleus: the signed-in company surface. The root layout still wraps
  this group but hides its header for `/(nucleus)` route ids.
  Without an active visual set, marketing-light-theme pins this subtree to the
  white light palette; with one, the brand tokens apply as-is.
-->
<div
  class={[
    'flex min-h-dvh flex-col text-foreground',
    brandActive ? 'bg-background' : 'marketing-light-theme bg-background',
  ]}
>
  {#if withShell && data.shell}
    <AppShell
      shell={data.shell}
      pathname={page.url.pathname}
      user={data.user}
      language={data.preferredLanguage}
      presence={selfPresence}
      inkFrame={!brandActive}
    >
      {@render children()}
    </AppShell>
  {:else}
    {@render children()}
  {/if}
  {#if data.user}
    <MiniCall
      active={activeCall}
      live={liveCalls}
      hidden={page.route.id === '/(nucleus)/calls/[id]' && page.params.id === activeCall.call?.id}
      onopen={(id) => goto(resolve(`/calls/${id}`))}
    />
    <IncomingCallToast
      live={liveCalls}
      client={calls}
      inCall={activeCall.inCall ? (activeCall.call?.id ?? null) : null}
      onjoin={(id) => goto(resolve(`/calls/${id}`))}
    />
  {/if}
</div>
