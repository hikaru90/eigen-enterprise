<script lang="ts">
  import type { TemporalEventListItem } from '../api/temporal-events/+server'
  import MemoryAuthorBadge from '$lib/components/memory-author-badge.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import TemporalEventStatusButton from './temporal-event-status-button.svelte'
  import {
    completedEventSummaryClass,
    formatCreatedDate,
    formatWhen,
    isTemporalEventCompleted,
  } from './temporal-events-utils'

  type Props = {
    items: TemporalEventListItem[]
    selectedItemId?: string | null
    updatingEventId?: string | null
    onSelect: (item: TemporalEventListItem) => void
    onQuickAction: (eventId: string, action: 'mark_done' | 'reopen') => void
    /** A colleague's shared project: tasks are shown, never changed or opened for editing. */
    readOnly?: boolean
  }

  let {
    items,
    selectedItemId = null,
    updatingEventId = null,
    onSelect,
    onQuickAction,
    readOnly = false,
  }: Props = $props()
</script>

<div
  class="flex min-h-0 flex-1 flex-col overflow-y-auto pb-28"
  role="list"
  aria-label={m.graph_timeline_projects_aria()}
  data-testid="project-list-view"
>
  {#if items.length === 0}
    <p class="text-muted-foreground px-1 py-8 text-center text-sm">
      {m.graph_timeline_project_empty_tasks()}
    </p>
  {:else}
    {#each items as item (item.id)}
      {@const completed = isTemporalEventCompleted(item)}
      <div
        class="border-border flex items-start gap-4 border-b px-1 py-2 last:border-b-0 {selectedItemId ===
        item.id
          ? 'bg-muted/30'
          : ''}"
        role="listitem"
      >
        {#if readOnly}
          <span
            class="mt-1 size-3.5 shrink-0 rounded-full border border-border {completed ? 'bg-muted-foreground/40' : ''}"
            aria-label={completed ? 'Done' : 'Open'}
            role="img"
          ></span>
        {:else}
          <TemporalEventStatusButton {item} compact {updatingEventId} {onQuickAction} />
        {/if}
        {#snippet summary()}
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              class="text-foreground text-sm leading-snug {completedEventSummaryClass(completed)}"
            >
              {item.semanticSummary}
            </span>
            <MemoryAuthorBadge author={item.author} authorLabel={item.authorLabel} size="sm" />
          </div>
          <div class="flex flex-col gap-0.5">
            {#if item.startAt}
              <span class="text-foreground/60 font-mono text-xs leading-tight"
                >{m.graph_temporal_when()} {formatWhen(item)}</span
              >
            {/if}
            <span class="text-muted-foreground font-mono text-xs leading-tight"
              >Created {formatCreatedDate(item)}</span
            >
          </div>
        {/snippet}
        {#if readOnly}
          <div class="flex min-w-0 flex-1 flex-col gap-1 text-left">{@render summary()}</div>
        {:else}
          <button
            type="button"
            class="flex min-w-0 flex-1 flex-col gap-1 text-left"
            onclick={() => onSelect(item)}
          >
            {@render summary()}
          </button>
        {/if}
      </div>
    {/each}
  {/if}
</div>
