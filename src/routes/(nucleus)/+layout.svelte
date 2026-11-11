<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { callsClient } from '$lib/calls/client'
  import IncomingCallToast from '$lib/calls/incoming-call-toast.svelte'
  import { LiveCalls, setLiveCalls } from '$lib/calls/live-calls.svelte'
  import AppShell from '$lib/components/app-shell.svelte'
  import { shellVisible } from '$lib/shell/nav'

  let { data, children } = $props()

  // Ring everywhere (plan/video-calls.md owner decision 5): one call feed for
  // every nucleus page — opened here on mount, closed on destroy — feeding the
  // incoming-call toast and the Messages call button.
  const liveCalls = setLiveCalls(new LiveCalls())
  const calls = callsClient()
  const resume = () => liveCalls.resume()
  const onVisible = () => {
    if (document.visibilityState === 'visible') resume()
  }

  onMount(() => {
    if (!data.user) return
    liveCalls.connect(() => new EventSource('/api/calls/stream'))
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', onVisible)
  })

  onDestroy(() => {
    liveCalls.close()
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
    brandActive ? 'bg-background' : 'marketing-light-theme bg-white',
  ]}
>
  {#if withShell && data.shell}
    <AppShell
      shell={data.shell}
      pathname={page.url.pathname}
      user={data.user}
      language={data.preferredLanguage}
    >
      {@render children()}
    </AppShell>
  {:else}
    {@render children()}
  {/if}
  {#if data.user}
    <IncomingCallToast live={liveCalls} client={calls} onjoin={(id) => goto(resolve(`/calls/${id}`))} />
  {/if}
</div>
