<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- mailto:, tel: and external profile links, never app routes */
  import type { Channel } from '../types'
  import { CHANNEL_LABELS, channelHref } from '../types'

  /** A contact's channels: mail, call or open the profile; values that aren't links show as text. */
  let { channels, limit }: { channels: readonly Channel[]; limit?: number } = $props()
  const shown = $derived(limit === undefined ? channels : channels.slice(0, limit))
</script>

{#if shown.length > 0}
  <ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="channel-links">
    {#each shown as c, i (i)}
      {@const href = channelHref(c)}
      <li class="min-w-0">
        <span class="text-muted-foreground">{CHANNEL_LABELS[c.type]}</span>
        {#if href}
          <a
            class="break-all underline-offset-2 hover:underline"
            {href}
            target={c.type === 'linkedin' || c.type === 'website' || c.type === 'other' ? '_blank' : undefined}
            rel="noopener noreferrer">{c.value}</a
          >
        {:else}
          <span class="break-all">{c.value}</span>
        {/if}
      </li>
    {/each}
  </ul>
{/if}
