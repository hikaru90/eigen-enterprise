<script lang="ts">
  import CopyButton from '$lib/components/email/copy-button.svelte'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * How to reach an AI co-worker in Messages: "Mention as @nova-mwujrl74", the
   * exact token that asks it for a turn, with a copy button. The composer's @
   * suggestions insert the same token.
   */
  let { handle, testid = 'coworker-handle' }: { handle: string; testid?: string } = $props()
  const token = $derived(`@${handle}`)
</script>

<p class="flex items-center gap-1 text-xs text-muted-foreground" data-testid={testid} data-handle={handle}>
  <span>{m.coworkers_mention_as()} <code class="font-mono text-foreground">{token}</code></span>
  <CopyButton value={token} label={m.coworkers_mention_copy({ handle: token })} testid="{testid}-copy" />
</p>
