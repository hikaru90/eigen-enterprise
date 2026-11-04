<script lang="ts">
  import Check from '@lucide/svelte/icons/check'
  import CopyIcon from '@lucide/svelte/icons/copy'

  /** Copies one value to the clipboard; the icon confirms for two seconds. */
  let { value, label, testid }: { value: string; label: string; testid?: string } = $props()
  let copied = $state(false)

  async function copy() {
    await navigator.clipboard.writeText(value)
    copied = true
    setTimeout(() => (copied = false), 2000)
  }
</script>

<button
  type="button"
  class="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
  onclick={() => void copy()}
  aria-label={copied ? 'Copied' : label}
  title={copied ? 'Copied' : label}
  data-testid={testid}
>
  {#if copied}<Check class="size-3.5" />{:else}<CopyIcon class="size-3.5" />{/if}
</button>
