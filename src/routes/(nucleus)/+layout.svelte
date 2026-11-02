<script lang="ts">
  import { page } from '$app/state'
  import AppShell from '$lib/components/app-shell.svelte'
  import { shellVisible } from '$lib/shell/nav'

  let { data, children } = $props()

  // Decided from page data, no effect: the welcome tour and the first-run
  // provider gate on / set showWelcome / needsOnboarding and run full-screen.
  const pageFlags = $derived(page.data as { showWelcome?: boolean; needsOnboarding?: boolean })
  const withShell = $derived(shellVisible({ shell: data.shell, ...pageFlags }))
</script>

<svelte:head>
  <title>eigenEnterprise</title>
</svelte:head>

<!--
  The nucleus: the signed-in company surface. The root layout still wraps
  this group but hides its header for `/(nucleus)` route ids.
  marketing-light-theme pins this subtree to the white light palette.
-->
<div class="marketing-light-theme flex min-h-dvh flex-col bg-white text-foreground">
  {#if withShell && data.shell}
    <AppShell shell={data.shell} pathname={page.url.pathname} user={data.user}>
      {@render children()}
    </AppShell>
  {:else}
    {@render children()}
  {/if}
</div>
