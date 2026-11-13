<script lang="ts">
  /**
   * The one product wordmark, one spelling everywhere: eigenEnterprise —
   * the website's mark (six nodes, their links) and the name in mono.
   */
  let { href }: { href?: string } = $props()
</script>

{#snippet mark()}
  <svg class="size-[22px] shrink-0" viewBox="0.3 0.3 7.3 7.3" aria-hidden="true">
    <path
      d="M5.35 6.75L6.75 3M5.35 6.75L2.75 4.85M6.75 3L4.55 1.05M4.55 1.05L1.9 3M2.75 4.85L1.9 3M2.75 4.85L0.95 4.8M1.9 3L0.95 4.8"
      fill="none"
      stroke="currentColor"
      stroke-width="0.2"
    />
    <g fill="currentColor">
      <rect x="4.627" y="6.027" width="1.445" height="1.445" rx="0.14" />
      <rect x="6.046" y="2.296" width="1.407" height="1.407" rx="0.14" />
      <rect x="3.889" y="0.389" width="1.322" height="1.322" rx="0.14" />
      <rect x="2.107" y="4.207" width="1.287" height="1.287" rx="0.14" />
      <rect x="1.287" y="2.387" width="1.225" height="1.225" rx="0.14" />
      <rect x="0.349" y="4.199" width="1.202" height="1.202" rx="0.14" />
    </g>
  </svg>
{/snippet}

{#if href}
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass a resolved or external href -->
  <a {href} class="inline-flex items-center gap-2.5 font-mono text-lg tracking-tight" data-testid="wordmark"
    >{@render mark()}<span>eigenEnterprise</span></a
  >
{:else}
  <span class="inline-flex items-center gap-2.5 font-mono text-lg tracking-tight" data-testid="wordmark"
    >{@render mark()}<span>eigenEnterprise</span></span
  >
{/if}
