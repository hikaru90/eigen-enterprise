<script lang="ts">
  import type { TemporalEventListItem } from '../api/temporal-events/+server'
  import MemoryAuthorBadge from '$lib/components/memory-author-badge.svelte'
  import { Button } from '$lib/components/ui/button'
  import { m } from '$lib/paraglide/messages.js'
  import TemporalEventStatusButton from './temporal-event-status-button.svelte'
  import {
    completedEventSummaryClass,
    formatCreatedDate,
    formatWhen,
    isTemporalEventCompleted,
  } from './temporal-events-utils'

  /**
   * Memory › Projects: the tasks not in any project yet. A labelled section
   * whose title is a heading, never a control; each row starts with the round
   * "Mark done" control and ends with Assign (file it under a project)
   * (Contribute d5e61e1f).
   */
  type Props = {
    tasks: TemporalEventListItem[]
    updatingEventId?: string | null
    onQuickAction: (eventId: string, action: 'mark_done' | 'reopen') => void | Promise<void>
    onGoToTask: (itemId: string) => void
    onAssign: (task: TemporalEventListItem) => void
  }

  let { tasks, updatingEventId = null, onQuickAction, onGoToTask, onAssign }: Props = $props()
</script>

<section class="mt-4 pt-3" aria-labelledby="unassigned-tasks-heading" data-testid="unassigned-tasks">
  <div class="px-2 pb-2">
    <h3 id="unassigned-tasks-heading" class="text-sm font-medium text-foreground">
      {m.graph_timeline_project_no_project()} ({tasks.length})
    </h3>
    <p class="mt-0.5 text-xs text-muted-foreground" data-testid="unassigned-tasks-hint">
      {m.graph_timeline_project_no_project_hint()}
    </p>
  </div>
  <ul class="flex flex-col">
    {#each tasks as task (task.id)}
      {@const taskCompleted = isTemporalEventCompleted(task)}
      <li class="border-border flex items-start gap-3 border-b py-2 pl-2 pr-3 last:border-b-0">
        <TemporalEventStatusButton item={task} compact {updatingEventId} {onQuickAction} />
        <button
          type="button"
          class="flex min-w-0 flex-1 flex-col gap-1 text-left"
          onclick={() => onGoToTask(task.id)}
        >
          <div class="flex min-w-0 flex-wrap items-center gap-1.5">
            <span
              class="text-foreground text-sm leading-snug {completedEventSummaryClass(taskCompleted)}"
            >
              {task.semanticSummary}
            </span>
            <MemoryAuthorBadge author={task.author} authorLabel={task.authorLabel} size="sm" />
          </div>
          <div class="flex flex-col gap-0.5">
            {#if task.startAt}
              <span class="text-foreground/60 font-mono text-xs leading-tight"
                >{m.graph_temporal_when()} {formatWhen(task)}</span
              >
            {/if}
            <span class="text-muted-foreground font-mono text-xs leading-tight"
              >Created {formatCreatedDate(task)}</span
            >
          </div>
        </button>
        <Button
          type="button"
          variant="ghost"
          class="h-auto shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-foreground hover:text-foreground/70"
          onclick={() => onAssign(task)}
        >
          Assign
        </Button>
      </li>
    {/each}
  </ul>
</section>
