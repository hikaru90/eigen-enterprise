<script lang="ts">
  import type { TemporalEventListItem } from '../api/temporal-events/+server'
  import CheckIcon from '@lucide/svelte/icons/check'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'
  import { hapticConfirm } from '$lib/haptics'
  import { m } from '$lib/paraglide/messages.js'
  import { isTemporalEventCompleted } from './temporal-events-utils'

  /**
   * Mark a task done / reopen it. The compact form sits at the start of a task
   * row: a round completion control with a subtle check even at rest (a to-do
   * circle that fills on hover/focus/done), never a square that reads as
   * "select this row" (Contribute d5e61e1f, ea945d0b). Its accessible name
   * carries the task — "Mark done: Order the flyers" — so a screen reader hears
   * what it completes, not a bare verb per row.
   */
  type Props = {
    item: TemporalEventListItem
    updatingEventId?: string | null
    compact?: boolean
    onQuickAction: (eventId: string, action: 'mark_done' | 'reopen') => void
  }

  let { item, updatingEventId = null, compact = false, onQuickAction }: Props = $props()

  const completed = $derived(isTemporalEventCompleted(item))
  const busy = $derived(updatingEventId === item.id)
  const actionLabel = $derived(completed ? m.graph_temporal_reopen() : m.graph_temporal_mark_done())
  const itemLabel = $derived(
    completed
      ? m.graph_temporal_reopen_item({ title: item.semanticSummary })
      : m.graph_temporal_mark_done_item({ title: item.semanticSummary }),
  )

  function handleClick(event: MouseEvent) {
    event.stopPropagation()
    event.preventDefault()
    if (busy) return
    hapticConfirm()
    onQuickAction(item.id, completed ? 'reopen' : 'mark_done')
  }
</script>

{#if compact}
  <!-- 24px hit target (WCAG 2.5.8) around an 18px circle. -->
  <button
    type="button"
    class="group/done flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    title={actionLabel}
    aria-label={itemLabel}
    data-shape="round"
    data-state={completed ? 'done' : 'open'}
    disabled={busy}
    onclick={handleClick}
  >
    <span
      class="flex size-[18px] items-center justify-center rounded-full border transition-colors {completed
        ? 'border-primary bg-primary text-primary-foreground group-hover/done:border-primary/85 group-hover/done:bg-primary/85 group-focus-visible/done:border-primary/85 group-focus-visible/done:bg-primary/85'
        : 'border-muted-foreground/70 bg-background text-muted-foreground/45 group-hover/done:border-primary group-hover/done:bg-primary group-hover/done:text-primary-foreground group-focus-visible/done:border-primary group-focus-visible/done:bg-primary group-focus-visible/done:text-primary-foreground'}"
      aria-hidden="true"
    >
      {#if busy}
        <LoaderCircleIcon
          class="size-3 animate-spin {completed ? 'text-primary-foreground' : 'text-foreground'}"
        />
      {:else}
        <CheckIcon class="size-3" strokeWidth={2.5} />
      {/if}
    </span>
  </button>
{:else}
  <button
    type="button"
    class="h-8 shrink-0 rounded-md border border-border px-3 text-xs font-medium transition-colors disabled:opacity-50 {completed
      ? 'bg-muted/30 text-foreground hover:bg-muted/50'
      : 'border-transparent bg-primary text-primary-foreground hover:bg-primary/90'}"
    disabled={busy}
    onclick={handleClick}
  >
    {#if busy}
      <LoaderCircleIcon class="mr-1 inline size-3.5 animate-spin" aria-hidden="true" />
    {/if}
    {actionLabel}
  </button>
{/if}
