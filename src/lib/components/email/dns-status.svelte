<script lang="ts">
  /** A DNS record's / domain's verification state in plain words. */
  let { status }: { status: string } = $props()
  const LABEL: Record<string, string> = {
    SUCCESS: 'Verified',
    PENDING: 'Waiting for DNS',
    NOT_STARTED: 'Not found yet',
    FAILED: 'Failed',
    TEMPORARY_FAILURE: 'Retrying',
  }
  const tone = $derived(
    status === 'SUCCESS'
      ? 'border-primary/40 text-foreground'
      : status === 'FAILED'
        ? 'border-destructive/30 text-destructive'
        : 'border-border text-muted-foreground',
  )
</script>

<span class="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium {tone}" data-testid="dns-status"
  ><span class="size-1.5 rounded-full {status === 'SUCCESS' ? 'bg-primary' : status === 'FAILED' ? 'bg-destructive' : 'bg-muted-foreground/40'}"
  ></span>{LABEL[status] ?? status}</span
>
