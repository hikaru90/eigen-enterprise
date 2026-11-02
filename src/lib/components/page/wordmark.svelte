<script lang="ts">
  /** The one product wordmark, one spelling everywhere: eigenEnterprise. */
  let { href }: { href?: string } = $props()
</script>

{#if href}
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass a resolved or external href -->
  <a {href} class="inline-block text-lg font-semibold tracking-tight" data-testid="wordmark"
    >eigenEnterprise</a
  >
{:else}
  <span class="inline-block text-lg font-semibold tracking-tight" data-testid="wordmark"
    >eigenEnterprise</span
  >
{/if}
