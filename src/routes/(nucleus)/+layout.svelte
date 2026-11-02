<script lang="ts">
  import { page } from '$app/state'
  import AppShell from '$lib/components/app-shell.svelte'
  import { shellVisible } from '$lib/shell/nav'

  let { data, children } = $props()

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
  <title>Eigen Enterprise</title>
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
    <AppShell shell={data.shell} pathname={page.url.pathname} user={data.user}>
      {@render children()}
    </AppShell>
  {:else}
    {@render children()}
  {/if}
</div>
