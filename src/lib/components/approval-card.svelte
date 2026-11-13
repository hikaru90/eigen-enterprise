<script lang="ts">
  import type { ApprovalDecision } from '$lib/chat/approvals-client'

  type Props = {
    /** The gated action in plain words. */
    action: string
    tool: string
    status: 'pending' | 'approved' | 'denied' | 'unavailable'
    /** Owner/admin, a request id, and still pending. */
    canDecide: boolean
    /** A decision is being sent: lock the buttons. */
    deciding: boolean
    /** Fixed, human failure text (never server text). */
    error: string | null
    ondecide: (decision: ApprovalDecision) => void
  }

  let { action, tool, status, canDecide, deciding, error, ondecide }: Props = $props()

  const decidedLabel: Record<'approved' | 'denied' | 'unavailable', string> = {
    approved: 'Approved',
    denied: 'Denied',
    unavailable: 'This request can no longer be decided here.',
  }
</script>

<div
  class="my-2 rounded-sm border-2 border-black bg-white px-3 py-3 text-black"
  data-testid="approval-card"
>
  <p class="text-xs font-medium tracking-[0.2em] text-black/60 uppercase">
    Needs your approval
  </p>
  <p class="mt-1 text-sm font-medium wrap-break-word">{action}</p>
  <p class="text-xs text-black/50 wrap-break-word">{tool} · has not run yet</p>

  {#if status === 'pending'}
    {#if canDecide}
      <div class="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          class="bg-primary px-4 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          disabled={deciding}
          onclick={() => ondecide('approved')}
        >
          Approve
        </button>
        <button
          type="button"
          class="border-2 border-primary bg-background px-4 py-1 text-sm text-primary hover:bg-primary/5 disabled:opacity-50"
          disabled={deciding}
          onclick={() => ondecide('denied')}
        >
          Deny
        </button>
      </div>
    {:else}
      <p class="mt-2 text-xs text-black/60">Waiting for the owner to decide.</p>
    {/if}
  {:else}
    <p class="mt-2 text-xs font-medium" data-testid="approval-card-decision">
      {decidedLabel[status]}
    </p>
  {/if}

  {#if error}
    <p class="text-destructive mt-2 text-xs" role="alert">{error}</p>
  {/if}
</div>
