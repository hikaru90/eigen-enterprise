<script lang="ts">
  import { resolve } from '$app/paths'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import StatusPill from '$lib/components/page/status-pill.svelte'
  import type { Address } from '$lib/domains/host-status'
  import type { ErrorReport } from '$lib/errors/agent-report'

  /**
   * A module page's addresses (plan/domains-one-claim.md: module pages only
   * show and link): each hostname with its status and "Change in Settings ›
   * Domains", deep-linked to that hostname. Domains are a global setting
   * edited only there.
   */
  let {
    addresses,
    error = null,
    empty,
  }: {
    addresses: Address[]
    error?: ErrorReport | null
    /** What to say when nothing shows this yet. */
    empty: string
  } = $props()

  const settings = resolve('/settings/domains')
</script>

<div class="flex flex-col gap-2" data-testid="host-addresses">
  {#if error}<ErrorNotice error={error.error} agent={error.agent} />{/if}
  {#if addresses.length === 0}
    <p class="text-sm text-muted-foreground">
      {empty}
      <a class="underline underline-offset-2" href={settings}>Add one in Settings › Domains</a>.
    </p>
  {:else}
    <ul class="flex flex-col gap-2">
      {#each addresses as a (a.host)}
        <li class="flex flex-wrap items-center gap-3" data-testid="host-address">
          <a
            class="text-sm break-all underline underline-offset-2"
            href="https://{a.host}"
            target="_blank"
            rel="external noopener noreferrer">{a.host}</a
          >
          <StatusPill label={a.label} on={a.on} />
          <a
            class="text-xs text-muted-foreground underline-offset-4 hover:underline"
            href="{settings}#{a.host}">Change in Settings › Domains</a
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>
