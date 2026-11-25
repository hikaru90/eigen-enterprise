<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import { tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type {
    CaptureRecentThoughtSnippet,
    CaptureSubmitResult,
  } from '$lib/capture/capture-result-types'
  import CaptureStoredSummary from '$lib/components/capture-stored-summary.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Select from '$lib/components/ui/select'
  import {
    brainKnowsIndexLabel,
    brainKnowsIndexState,
    brainKnowsSource,
    brainKnowsSourceLabel,
    type BrainKnowsIndexState,
  } from '$lib/memory/brain-knows'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Memory › What the brain knows (plan/concept-memory-one-door.md §2.2): the
   * read-only list of what the brain took in, newest first — each thought with
   * where it came from, its category, its date and whether it is indexed yet
   * (indexed · not indexed yet · indexing · failed + Retry), Delete, and the
   * detail on expand. Nothing is typed in here: the Ask bar is the one door.
   * The same rows are memory.list_thoughts for the CLI and the agent.
   */
  let {
    thoughts,
    thoughtDetails,
    enrichingThoughtIds = new Set<string>(),
    expandedId = null,
    deletingId = null,
    retryingId = null,
    loadingDetailId = null,
    limit,
    onExpand,
    onCollapse,
    onDelete,
    onRetry,
    onUnlinkFile,
    onNoteUpdated,
    onFilterChange,
  }: {
    thoughts: CaptureRecentThoughtSnippet[]
    thoughtDetails: Record<string, CaptureSubmitResult>
    /** Thoughts this page is watching while they index (shown as indexing). */
    enrichingThoughtIds?: ReadonlySet<string>
    expandedId?: string | null
    deletingId?: string | null
    retryingId?: string | null
    loadingDetailId?: string | null
    /** How many the list shows at most (it says so when it is full). */
    limit: number
    onExpand: (thoughtId: string) => void | Promise<void>
    onCollapse: (thoughtId: string) => void
    onDelete: (thoughtId: string) => void
    onRetry: (thoughtId: string) => void
    onUnlinkFile?: (thoughtId: string, fileId: string) => void
    onNoteUpdated?: (thoughtId: string) => void | Promise<void>
    onFilterChange?: (filter: { category?: string }) => void
  } = $props()

  const dateFormat = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  function formatWhen(iso: string): string {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) throw new Error(`thought date is not a date: ${iso}`)
    return dateFormat.format(date)
  }

  function toggleThought(snippetId: string, expanded: boolean) {
    if (expanded) {
      onCollapse(snippetId)
      return
    }
    void (async () => {
      await onExpand(snippetId)
      await scrollEntryIntoView(snippetId)
    })()
  }

  const entryElements = new SvelteMap<string, HTMLElement>()

  function entryAnchor(node: HTMLElement, thoughtId: string) {
    entryElements.set(thoughtId, node)
    return {
      destroy() {
        entryElements.delete(thoughtId)
      },
    }
  }

  async function scrollEntryIntoView(thoughtId: string) {
    await tick()
    entryElements.get(thoughtId)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  /** null while the row's detail (its enrichment state) has not arrived yet. */
  function indexState(thoughtId: string): BrainKnowsIndexState | null {
    const detail = thoughtDetails[thoughtId]
    if (!detail) return null
    const state = brainKnowsIndexState(detail)
    return state === 'pending' && enrichingThoughtIds.has(thoughtId) ? 'indexing' : state
  }

  const statusClass: Record<BrainKnowsIndexState, string> = {
    indexed: 'border-border text-muted-foreground',
    pending: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
    indexing: 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300',
    failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  }

  let categoryFilter = $state<string>('all')

  const categories = $derived([...new Set(thoughts.map((t) => t.category).filter(Boolean))].sort())

  function handleFilterChange() {
    const filter: { category?: string } = {}
    if (categoryFilter !== 'all') filter.category = categoryFilter
    onFilterChange?.(filter)
  }
</script>

{#if thoughts.length === 0 && categoryFilter === 'all'}
  <p class="px-1 py-10 text-center text-sm text-muted-foreground" data-testid="brain-knows-empty">
    {m.memory_knows_empty()}
  </p>
{:else}
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="relative z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 bg-background pb-2">
      <h2 class="text-sm font-medium text-muted-foreground">{m.memory_knows_list_label()}</h2>
      {#if categories.length > 1 || categoryFilter !== 'all'}
        <Select.Root
          type="single"
          bind:value={categoryFilter}
          onValueChange={() => handleFilterChange()}
        >
          <Select.Trigger class="h-auto w-auto gap-1 px-2 py-1 text-sm">
            {m.memory_knows_category()}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="all">{m.memory_knows_all_categories()}</Select.Item>
            {#each categories as cat (cat)}
              <Select.Item value={cat}>{cat}</Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
      {/if}
    </div>
    <div class="relative min-h-0 flex-1">
      <div
        class="absolute inset-0 z-0 overflow-y-auto pb-28 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      >
        <ul class="flex flex-col gap-2" aria-label={m.memory_knows_list_label()}>
          {#each thoughts as snippet (snippet.id)}
            {@const detail = thoughtDetails[snippet.id]}
            {@const expanded = expandedId === snippet.id}
            {@const state = indexState(snippet.id)}
            {@const source = brainKnowsSource({
              source: snippet.source ?? null,
              author: detail?.author ?? snippet.author ?? 'user',
              authorLabel: detail?.authorLabel ?? snippet.authorLabel ?? null,
            })}
            <li
              class="flex min-w-0 flex-col overflow-visible rounded-lg border border-border bg-card"
              use:entryAnchor={snippet.id}
              data-testid="brain-knows-row"
            >
              <div class="flex w-full min-w-0 items-start justify-between gap-2 px-3 py-2">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-start gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  aria-expanded={expanded}
                  aria-label={expanded ? m.memory_knows_hide_details() : m.memory_knows_show_details()}
                  onclick={() => toggleThought(snippet.id, expanded)}
                >
                  {#if expanded}
                    <ChevronDown class="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
                  {:else}
                    <ChevronRight class="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden="true" />
                  {/if}
                  <div class="min-w-0 flex-1">
                    <p class="whitespace-pre-wrap text-sm {expanded ? 'line-clamp-3' : 'line-clamp-2'}">
                      {snippet.normalizedText}
                    </p>
                    <div
                      class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
                    >
                      <span data-testid="brain-knows-source">{brainKnowsSourceLabel(source)}</span>
                      <span class="font-medium text-foreground" data-testid="brain-knows-category">
                        {snippet.category}
                      </span>
                      <time datetime={snippet.createdAt}>{formatWhen(snippet.createdAt)}</time>
                      {#if state}
                        <span
                          class="inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 {statusClass[state]}"
                          data-testid="brain-knows-status"
                          data-state={state}
                        >
                          {#if state === 'indexing'}
                            <LoaderCircleIcon class="size-3 shrink-0 animate-spin" aria-hidden="true" />
                          {/if}
                          {brainKnowsIndexLabel(state)}
                        </span>
                      {/if}
                    </div>
                  </div>
                </button>
                <div class="-mt-0.5 flex shrink-0 items-center gap-1">
                  {#if state === 'failed'}
                    <Button
                      type="button"
                      variant="ghost"
                      class="h-auto rounded-full px-2 py-0.5 text-sm text-muted-foreground hover:text-foreground"
                      disabled={retryingId === snippet.id}
                      data-testid="brain-knows-retry"
                      onclick={() => onRetry(snippet.id)}
                    >
                      {retryingId === snippet.id ? m.memory_knows_retrying() : m.memory_knows_retry()}
                    </Button>
                  {/if}
                  <Button
                    type="button"
                    variant="ghost"
                    class="h-auto rounded-full p-1.5 text-destructive hover:bg-destructive/10"
                    aria-label={deletingId === snippet.id ? m.memory_knows_deleting() : m.memory_knows_delete()}
                    disabled={deletingId === snippet.id}
                    data-testid="brain-knows-delete"
                    onclick={() => onDelete(snippet.id)}
                  >
                    {#if deletingId === snippet.id}
                      <LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" />
                    {:else}
                      <Trash2 class="size-4" strokeWidth={2} aria-hidden="true" />
                    {/if}
                  </Button>
                </div>
              </div>
              {#if state === 'failed' && detail?.queueError}
                <ErrorNotice
                  class="px-3 pb-2 text-sm"
                  error={detail.queueError}
                  attempted="Indexing a thought the brain took in (background enrichment job)"
                />
              {/if}

              {#if expanded}
                <div class="space-y-3 border-t border-border px-3 pt-2 pb-3">
                  {#if loadingDetailId === snippet.id || !detail}
                    <p class="text-sm text-muted-foreground">{m.memory_knows_loading_detail()}</p>
                  {:else}
                    <CaptureStoredSummary
                      thought={detail}
                      embedded
                      onUnlinkFile={onUnlinkFile
                        ? (fileId) => onUnlinkFile(snippet.id, fileId)
                        : undefined}
                      onNoteUpdated={onNoteUpdated ? () => onNoteUpdated(snippet.id) : undefined}
                    />
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
        {#if thoughts.length === 0}
          <p class="px-1 py-2 text-sm text-muted-foreground">{m.memory_knows_no_match()}</p>
        {:else if thoughts.length >= limit}
          <p class="px-1 py-2 text-sm text-muted-foreground" data-testid="brain-knows-newest">
            {m.memory_knows_newest({ count: limit })}
          </p>
        {/if}
      </div>
    </div>
  </div>
{/if}
