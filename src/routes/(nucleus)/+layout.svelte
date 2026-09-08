<script lang="ts">
  let { children } = $props()
</script>

<svelte:head>
  <title>Eigen Enterprise</title>
</svelte:head>

<!--
  The nucleus: one white surface, no console chrome. The root layout still
  wraps this group (SvelteKit always nests the root layout) but hides the app
  header/nav for `/(nucleus)` route ids. marketing-light-theme pins this
  subtree to the white light palette regardless of the user's dark preference.
-->
<div class="marketing-light-theme flex min-h-dvh flex-col bg-white text-foreground">
  {@render children()}
</div>
