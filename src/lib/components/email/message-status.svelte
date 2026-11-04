<script lang="ts">
  import { isProblemStatus, STATUS_LABEL, type MessageStatus } from '../../../../modules/email/platform/status'

  /** One sent-mail status as a small pill: problems in the destructive tone, progress muted, delivery on. */
  let { status }: { status: string } = $props()
  const s = $derived(status as MessageStatus)
  const tone = $derived(
    isProblemStatus(s)
      ? 'border-destructive/30 text-destructive'
      : s === 'delivered' || s === 'opened' || s === 'clicked'
        ? 'border-primary/40 text-foreground'
        : 'border-border text-muted-foreground',
  )
</script>

<span class="inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium {tone}" data-testid="message-status"
  >{STATUS_LABEL[s] ?? status}</span
>
