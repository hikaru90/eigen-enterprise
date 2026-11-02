<script lang="ts">
  import type { TemporalEventListItem } from '../api/temporal-events/+server'
  import CheckIcon from '@lucide/svelte/icons/check'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'
  import { hapticConfirm } from '$lib/haptics'
  import { m } from '$lib/paraglide/messages.js'
  import { isTemporalEventCompleted } from './temporal-events-utils'

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

  function handleClick(event: MouseEvent) {
    event.stopPropagation()
    event.preventDefault()
    if (busy) return
    hapticConfirm()
    onQuickAction(item.id, completed ? 'reopen' : 'mark_done')
  }
</script>

{#if compact}
  <button
    type="button"
    class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border border-input bg-background transition-colors disabled:opacity-50 {completed
      ? 'text-foreground'
      : 'text-transparent hover:bg-muted'}"
    title={actionLabel}
    aria-label={actionLabel}
    disabled={busy}
    onclick={handleClick}
  >
    {#if busy}
      <LoaderCircleIcon class="text-foreground size-3 animate-spin" aria-hidden="true" />
    {:else if completed}
      <CheckIcon class="size-3" strokeWidth={2.5} aria-hidden="true" />
    {:else}
      <span class="sr-only">{actionLabel}</span>
    {/if}
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
