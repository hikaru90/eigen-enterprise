<script lang="ts">
  import type { TemporalEventListItem } from '../api/temporal-events/+server'
  import type { AssignProjectResponse } from '../api/timeline/projects/assign/+server'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'
  import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw'
  import Undo2Icon from '@lucide/svelte/icons/undo-2'
  import XIcon from '@lucide/svelte/icons/x'
  import { onMount } from 'svelte'
  import { submitCaptureRaw } from '$lib/capture/queue/submit-capture'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import MorphSearchControl from '$lib/components/morph-search-control.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { ShownError } from '$lib/errors/agent-report'
  import type { CurrentUserView } from '$lib/memory/current-user-view'
  import { requestErrorOf, shownOf } from '$lib/memory/request-error'
  import { m } from '$lib/paraglide/messages.js'
  import { subscribeCurrentUserView } from '$lib/stores/current-user-view.svelte'
  import {
    notifyThoughtChanged,
    notifyThoughtRefreshAll,
    subscribeThoughtSync,
  } from '$lib/stores/thought-sync'
  import TemporalEventDetail from './temporal-event-detail.svelte'
  import {
    filterSnoozedItems,
    findTemporalListItemByRef,
    isTaskListItem,
    isTemporalEventCompleted,
    type NowSegment,
  } from './temporal-events-utils'
  import TemporalTimelineHeader from './temporal-timeline-header.svelte'
  import TemporalTimelineNudge from './temporal-timeline-nudge.svelte'
  import TemporalTimelineOptionsPopover from './temporal-timeline-options-popover.svelte'
  import TemporalTodaySegmentTabs from './temporal-today-segment-tabs.svelte'
  import TimelineAddTask from './timeline-add-task.svelte'
  import TimelineAgentAssignDialog from './timeline-agent-assign-dialog.svelte'
  import { shouldRefetchForViewChange, shouldRefetchPrefetchForView } from './timeline-client-loads'
  import { filterTimelineItemsBySearch } from './timeline-data-derive'
  import { createTimelineData, type TimelineUnifiedSourceState } from './timeline-data.svelte'
  import TimelineDateRangeDial from './timeline-date-range-dial.svelte'
  import {
    inverseTimelineQuickAction,
    postTimelineQuickAction,
    type TimelineQuickAction,
  } from './timeline-item-actions'
  import TimelineProjectAssignDialog from './timeline-project-assign-dialog.svelte'
  import TimelineProjectsView from './timeline-projects-view.svelte'
  import TimelineTasksView from './timeline-tasks-view.svelte'

  type Props = {
    mode: 'tasks' | 'projects'
    onSelectItem?: (item: TemporalEventListItem | null) => void
    selectedItemId?: string | null
    initialEventId?: string | null
    /** Prefetched unified timeline from page server load. */
    prefetchedSource?: TimelineUnifiedSourceState | null
    /** Author scope the prefetch was fetched with (SSR always 'user'). */
    prefetchedAuthorScope?: string | null
    userTimeZone?: string
    userName?: string | null
    eventNotificationsEnabled?: boolean
    eventReminderLeadMinutes?: number
    initialSegment?: NowSegment | null
  }

  let {
    mode,
    onSelectItem,
    selectedItemId = null,
    initialEventId = null,
    prefetchedSource = null,
    prefetchedAuthorScope = null,
    userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
    eventNotificationsEnabled = false,
    eventReminderLeadMinutes = 10,
    initialSegment = null,
  }: Props = $props()

  const data = createTimelineData({
    userTimeZone,
    initialSource: prefetchedSource,
  })
  type QuickActionToast = {
    eventId: string
    summary: string
    undoAction: 'mark_done' | 'reopen'
  }
  const QUICK_ACTION_TOAST_MS = 8_000

  let nowSegment = $state<NowSegment>('todo')
  let updatingEventId = $state<string | null>(null)
  let actionBusy = $state(false)
  let actionError = $state<ShownError | null>(null)
  let lastActionSummary = $state<string | null>(null)
  let quickActionToast = $state<QuickActionToast | null>(null)
  let quickActionToastTimer: ReturnType<typeof setTimeout> | null = null
  let assignProjectOpen = $state(false)
  let assignProjectItem = $state<TemporalEventListItem | null>(null)
  let assignAgentOpen = $state(false)
  let assignAgentItem = $state<TemporalEventListItem | null>(null)
  let refreshingAll = $state(false)
  let internalSelectedItemId = $state<string | null>(null)
  let filtersPopoverOpen = $state(false)
  let suppressThoughtSyncReload = $state(false)
  let searchQuery = $state('')

  const selectionControlled = $derived(onSelectItem !== undefined)
  const activeSelectedItemId = $derived(
    selectionControlled ? selectedItemId : internalSelectedItemId,
  )

  const refreshBusy = $derived(refreshingAll || data.phase === 'loading')

  const snoozedItems = $derived(
    data.source ? filterSnoozedItems(data.source.items) : ([] as TemporalEventListItem[]),
  )

  const filteredTodoItems = $derived(filterTimelineItemsBySearch(data.todoItems, searchQuery))
  const filteredDoneItems = $derived(filterTimelineItemsBySearch(data.doneItems, searchQuery))
  const filteredOverdueItems = $derived(filterTimelineItemsBySearch(data.overdueItems, searchQuery))

  /** Counts are the lengths of the exact arrays each tab renders — never a parallel source. */
  const tabCounts = $derived({
    todo: filteredTodoItems.length,
    done: filteredDoneItems.length,
    overdue: filteredOverdueItems.length,
  })

  const selectedItem = $derived.by(() => {
    if (!activeSelectedItemId) return null
    const pools = [
      filteredTodoItems,
      filteredDoneItems,
      filteredOverdueItems,
      data.todoItems,
      data.doneItems,
      data.overdueItems,
      data.source?.items ?? [],
    ]
    for (const pool of pools) {
      const hit = findTemporalListItemByRef(pool, activeSelectedItemId)
      if (hit) return hit
    }
    return null
  })

  /** Global empty uses unfiltered todo — search-empty stays in the list view. */
  const showGlobalEmpty = $derived(
    data.phase === 'ready' &&
      data.todoItems.length === 0 &&
      mode === 'tasks' &&
      nowSegment === 'todo',
  )

  const totalReadyCount = $derived(data.source?.items.length ?? 0)

  function setSelection(item: TemporalEventListItem | null) {
    if (selectionControlled) {
      onSelectItem?.(item)
    } else {
      internalSelectedItemId = item?.id ?? null
    }
  }

  onMount(() => {
    // Prefetch seeds first paint; only fetch when no seed (or after filter/sync).
    if (!prefetchedSource) {
      void data.load()
    } else {
      if (shouldRefetchPrefetchForView(prefetchedAuthorScope, data.dataView)) {
        // Prefetch scope (SSR can't see localStorage) misses the selected view.
        void data.load()
      }
      if (initialEventId) {
        const hit = findTemporalListItemByRef(prefetchedSource.items, initialEventId)
        if (hit) setSelection(hit)
      }
    }
    if (initialSegment === 'overdue') {
      nowSegment = 'overdue'
    }

    let previousView: CurrentUserView | null = data.dataView
    const unsubscribeView = subscribeCurrentUserView((view) => {
      const refetch = shouldRefetchForViewChange(previousView, view)
      previousView = view
      if (refetch) data.setView(view)
    })

    const unsubscribeSync = subscribeThoughtSync((message) => {
      if (suppressThoughtSyncReload) return
      const reloadTimeline =
        message.type === 'refresh-all' || (message.type === 'changed' && message.scope === 'global')
      if (reloadTimeline) {
        void data.load({ silent: true })
      }
    })

    return () => {
      clearQuickActionToastTimer()
      unsubscribeView()
      unsubscribeSync()
    }
  })

  function clearQuickActionToastTimer() {
    if (quickActionToastTimer) clearTimeout(quickActionToastTimer)
    quickActionToastTimer = null
  }

  function dismissQuickActionToast() {
    clearQuickActionToastTimer()
    quickActionToast = null
  }

  function showQuickActionToast(toast: QuickActionToast) {
    clearQuickActionToastTimer()
    quickActionToast = toast
    quickActionToastTimer = setTimeout(() => {
      quickActionToastTimer = null
      quickActionToast = null
    }, QUICK_ACTION_TOAST_MS)
  }

  async function withThoughtSyncReloadSuppressedAsync<T>(fn: () => Promise<T>): Promise<T> {
    suppressThoughtSyncReload = true
    try {
      return await fn()
    } finally {
      suppressThoughtSyncReload = false
    }
  }

  function selectItem(item: TemporalEventListItem) {
    lastActionSummary = null
    setSelection(activeSelectedItemId === item.id ? null : item)
  }

  function deselectItem() {
    lastActionSummary = null
    setSelection(null)
  }

  function goToTaskFromProjects(itemId: string) {
    const pools = [
      data.todoItems,
      data.doneItems,
      data.overdueItems,
      data.openItems,
      data.source?.items ?? [],
    ]
    let item: TemporalEventListItem | null = null
    for (const pool of pools) {
      item = findTemporalListItemByRef(pool, itemId)
      if (item) break
    }
    if (!item) return
    lastActionSummary = null
    setSelection(item)
  }

  async function postEventAction(
    eventId: string,
    body: { action?: string; instruction?: string; startAt?: string; endAt?: string },
  ) {
    actionError = null
    lastActionSummary = null
    actionBusy = true
    updatingEventId = eventId
    try {
      const res = await fetch(`/api/temporal-events/${eventId}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw await requestErrorOf(res)
      const result = (await res.json()) as { item: TemporalEventListItem; summary: string }
      await withThoughtSyncReloadSuppressedAsync(async () => {
        await data.load({ silent: true })
        if (result.item.thoughtId) {
          notifyThoughtChanged(result.item.thoughtId, 'lifecycle', 'global')
        }
      })
      lastActionSummary = result.summary
    } catch (err) {
      actionError = shownOf(err)
    } finally {
      actionBusy = false
      updatingEventId = null
    }
  }

  async function runTimelineQuickAction(eventId: string, action: TimelineQuickAction) {
    actionError = null
    lastActionSummary = null
    dismissQuickActionToast()
    actionBusy = true
    updatingEventId = eventId
    try {
      const result = await postTimelineQuickAction(eventId, action)
      await withThoughtSyncReloadSuppressedAsync(async () => {
        await data.load({ silent: true })
        if (result.item.thoughtId) {
          notifyThoughtChanged(result.item.thoughtId, 'lifecycle', 'global')
        }
      })
      lastActionSummary = result.summary
      const undoAction = inverseTimelineQuickAction(action)
      if (undoAction) {
        showQuickActionToast({ eventId, summary: result.summary, undoAction })
      }
    } catch (err) {
      actionError = shownOf(err)
    } finally {
      actionBusy = false
      updatingEventId = null
    }
  }

  function undoQuickAction() {
    const toast = quickActionToast
    if (!toast || actionBusy) return
    dismissQuickActionToast()
    void runTimelineQuickAction(toast.eventId, toast.undoAction)
  }

  function onQuickAction(eventId: string, action: 'mark_done' | 'reopen' | 'archive') {
    void runTimelineQuickAction(eventId, action)
  }

  function onInstruction(eventId: string, instruction: string) {
    void postEventAction(eventId, { instruction })
  }

  function onReschedule(eventId: string, startAt: string, endAt: string) {
    void postEventAction(eventId, { action: 'reschedule', startAt, endAt })
  }

  async function onDelete(eventId: string) {
    actionError = null
    if (quickActionToast?.eventId === eventId) dismissQuickActionToast()
    actionBusy = true
    try {
      const res = await fetch(`/api/temporal-events/${eventId}`, { method: 'DELETE' })
      if (!res.ok) throw await requestErrorOf(res)
      const result = (await res.json()) as { summary: string }
      if (activeSelectedItemId === eventId) deselectItem()
      await data.load({ silent: true })
      lastActionSummary = result.summary
    } catch (err) {
      actionError = shownOf(err)
    } finally {
      actionBusy = false
    }
  }

  function refreshAll() {
    refreshingAll = true
    void (async () => {
      try {
        await withThoughtSyncReloadSuppressedAsync(async () => {
          await data.load({ silent: data.phase === 'ready' })
          notifyThoughtRefreshAll('manual', 'global')
        })
      } finally {
        refreshingAll = false
      }
    })()
  }

  /** Tasks › Add a task: the person says it is a task, so it is captured as one. */
  async function addTask(text: string) {
    const saved = await submitCaptureRaw(text, { category: 'task', streamProgress: false })
    await withThoughtSyncReloadSuppressedAsync(async () => {
      await data.load({ silent: data.phase === 'ready' })
      notifyThoughtChanged(saved.id, 'edit', 'global')
    })
    nowSegment = 'todo'
  }

  function setNowSegment(segment: NowSegment) {
    nowSegment = segment
  }

  function goToOverdue() {
    setNowSegment('overdue')
  }

  function openProjectAssign(item: TemporalEventListItem) {
    assignProjectItem = item
    assignProjectOpen = true
  }

  function closeProjectAssign() {
    assignProjectOpen = false
    assignProjectItem = null
  }

  function onProjectAssigned(payload: AssignProjectResponse & { thoughtId: string }) {
    lastActionSummary = payload.eligible
      ? m.graph_timeline_assign_project_success({ project: payload.projectLabel })
      : m.graph_timeline_assign_project_linked_hub({ name: payload.projectLabel })
    closeProjectAssign()
    void data.load({ silent: true })
  }

  function openAgentAssign(item: TemporalEventListItem) {
    assignAgentItem = item
    assignAgentOpen = true
  }

  function closeAgentAssign() {
    assignAgentOpen = false
    assignAgentItem = null
  }

  function onAgentAssigned(payload: { agentName: string; assignmentId: string }) {
    lastActionSummary = m.graph_timeline_assign_agent_success({ agent: payload.agentName })
    closeAgentAssign()
  }
</script>

<div
  class="relative flex h-full min-h-0 w-full flex-col overflow-hidden overscroll-none mx-auto max-w-5xl pt-4 sm:px-5"
>
  <TemporalTimelineHeader {mode}>
    {#snippet titleActions()}
      <div class="flex items-center gap-1">
        <TimelineDateRangeDial
          from={data.dateRange.from}
          to={data.dateRange.to}
          includeUndated={data.dateRange.includeUndated}
          label={data.dateRange.label}
          timeZone={userTimeZone}
          onChange={(next) => data.setDateRange(next)}
        />
        {#if mode === 'tasks'}
          <MorphSearchControl
            bind:search={searchQuery}
            placeholder={m.graph_timeline_tasks_search_placeholder()}
            triggerLabel={m.graph_timeline_tasks_search_placeholder()}
            inputId="timeline-tasks-search"
          />
        {/if}
        <TemporalTimelineOptionsPopover
          bind:open={filtersPopoverOpen}
          filtersActive={false}
          orderBy={data.orderBy}
          sortDirection={data.sortDirection}
          onOrderByChange={(next) => data.setSort(next, data.sortDirection)}
          onSortDirectionToggle={() =>
            data.setSort(data.orderBy, data.sortDirection === 'asc' ? 'desc' : 'asc')}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          class="size-7 shrink-0 text-foreground hover:bg-muted"
          title={m.graph_temporal_refresh()}
          disabled={refreshBusy}
          onclick={refreshAll}
        >
          <RefreshCwIcon class="size-3.5 {refreshBusy ? 'animate-spin' : ''}" aria-hidden="true" />
          <span class="sr-only">{m.graph_temporal_refresh()}</span>
        </Button>
      </div>
    {/snippet}
    {#if mode === 'tasks'}
      <TemporalTodaySegmentTabs segment={nowSegment} {tabCounts} onSegmentChange={setNowSegment} />
    {/if}
  </TemporalTimelineHeader>

  {#if mode === 'tasks'}
    <TimelineAddTask {addTask} />
  {/if}

  {#if snoozedItems.length > 0}
    <div class="border-border shrink-0 border-b px-3 py-1.5">
      <p class="text-muted-foreground mb-1 font-mono text-xs uppercase">
        {m.graph_timeline_snoozed()} ({snoozedItems.length})
      </p>
      <div class="flex flex-wrap gap-1">
        {#each snoozedItems as item (item.id)}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground rounded-sm border border-border px-2 py-0.5 text-xs"
            onclick={() => selectItem(item)}
          >
            {item.semanticSummary}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if data.phase === 'loading'}
    <div class="flex flex-1 flex-col items-center justify-center gap-3">
      <LoaderCircleIcon class="text-muted-foreground size-6 animate-spin" aria-hidden="true" />
      <p class="text-muted-foreground text-sm">{m.graph_temporal_loading()}</p>
    </div>
  {:else if data.phase === 'error'}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6">
      {#if data.loadError}
        <ErrorNotice
          class="items-center text-center"
          title={m.graph_temporal_load_error()}
          error={data.loadError.error}
          agent={data.loadError.agent}
          attempted="Loading the timeline"
        />
      {/if}
    </div>
  {:else if showGlobalEmpty}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      {#if totalReadyCount === 0}
        <p class="text-muted-foreground text-sm" data-testid="timeline-empty">
          {mode === 'tasks' ? m.graph_tasks_empty() : m.graph_temporal_empty()}
        </p>
        <p class="text-muted-foreground text-xs">
          {mode === 'tasks' ? m.graph_tasks_empty_hint() : m.graph_temporal_empty_hint()}
        </p>
      {:else}
        <p class="text-muted-foreground text-sm">{m.graph_temporal_no_open()}</p>
        <p class="text-muted-foreground text-xs">{m.graph_temporal_no_open_hint()}</p>
      {/if}
    </div>
  {:else if data.phase === 'ready'}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {#if mode === 'projects'}
        <TimelineProjectsView
          projectCards={data.projectCards}
          unassignedItems={data.unassignedItems}
          items={data.openItems}
          onGoToTask={goToTaskFromProjects}
          {onQuickAction}
          onRefresh={() => {
            void data.load({ silent: true })
          }}
          {updatingEventId}
        />
      {:else}
        <TimelineTasksView
          items={filteredTodoItems}
          doneItems={filteredDoneItems}
          overdueItems={filteredOverdueItems}
          selectedItemId={activeSelectedItemId}
          {updatingEventId}
          timeZone={userTimeZone}
          segment={nowSegment}
          onSelect={selectItem}
          {onQuickAction}
          onLongPress={openProjectAssign}
          onGoToOverdue={goToOverdue}
        />
        {#if nowSegment === 'todo'}
          <div class="shrink-0 pb-28">
            <TemporalTimelineNudge onAccept={onReschedule} />
          </div>
        {/if}
      {/if}
    </div>

    {#if actionError}
      <ErrorNotice
        class="border-border shrink-0 border-t px-4 py-2 text-xs"
        error={actionError.error}
        agent={actionError.agent}
        attempted="Changing a timeline item"
      />
    {/if}
  {/if}

  {#if quickActionToast}
    <div
      class="pointer-events-none absolute inset-x-4 bottom-4 z-30 flex justify-center"
      role="status"
      aria-live="polite"
      data-testid="timeline-quick-action-toast"
    >
      <div
        class="pointer-events-auto border-border bg-background/95 text-foreground flex w-full max-w-md items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur-sm"
      >
        <span class="min-w-0 truncate">{quickActionToast.summary}</span>
        <div class="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="h-7 gap-1 px-2.5 text-xs"
            data-testid="timeline-undo"
            disabled={actionBusy}
            onclick={undoQuickAction}
          >
            <Undo2Icon class="size-3.5" aria-hidden="true" />
            {m.graph_temporal_undo()}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="text-muted-foreground hover:text-foreground size-7"
            aria-label={m.graph_close()}
            title={m.graph_close()}
            data-testid="timeline-toast-dismiss"
            onclick={dismissQuickActionToast}
          >
            <XIcon class="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  {/if}

  <TemporalEventDetail
    item={selectedItem}
    timeZone={userTimeZone}
    {updatingEventId}
    {actionBusy}
    {lastActionSummary}
    {eventNotificationsEnabled}
    {eventReminderLeadMinutes}
    {onQuickAction}
    {onInstruction}
    {onDelete}
    showAssignAgent={selectedItem
      ? !isTemporalEventCompleted(selectedItem) &&
        (isTaskListItem(selectedItem) || selectedItem.projectEntityId !== null)
      : false}
    onAssignAgent={selectedItem ? () => openAgentAssign(selectedItem) : undefined}
    onClose={deselectItem}
  />

  {#if assignProjectOpen}
    <TimelineProjectAssignDialog
      open={true}
      item={assignProjectItem}
      onClose={closeProjectAssign}
      onAssigned={onProjectAssigned}
    />
  {/if}

  {#if assignAgentOpen}
    <TimelineAgentAssignDialog
      open={true}
      item={assignAgentItem}
      nested={selectedItem !== null}
      onClose={closeAgentAssign}
      onAssigned={onAgentAssigned}
    />
  {/if}
</div>
