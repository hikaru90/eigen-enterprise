<script lang="ts">
  import type { PageData } from './$types'
  import { onMount } from 'svelte'
  import { SvelteMap, SvelteURLSearchParams } from 'svelte/reactivity'
  import { page } from '$app/state'
  import { capture as captureEvent } from '$lib/analytics/posthog-client'
  import {
    deleteCaptureThought,
    fetchCaptureResult,
    retryCaptureEnrich,
  } from '$lib/capture/capture-result-api'
  import type {
    CaptureRecentThoughtSnippet,
    CaptureSubmitResult,
  } from '$lib/capture/capture-result-types'
  import {
    pollCaptureRecentSync,
    type RecentCaptureMergeResult,
  } from '$lib/capture/poll-capture-recent-sync'
  import { pollUntilEnrichmentComplete } from '$lib/capture/poll-enrichment'
  import { shouldRefetchRecentForViewChange } from '$lib/capture/recent-view-sync'
  import { shouldRejectDestructiveRecentSync } from '$lib/capture/reject-destructive-recent-sync'
  import { upsertRecentThoughtList } from '$lib/capture/upsert-recent-thought-list'
  import { logErrorToServer } from '$lib/client-log'
  import CaptureOnboardingOverlay from '$lib/components/capture-onboarding-overlay.svelte'
  import CaptureRecentThoughts from '$lib/components/capture-recent-thoughts.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import GroundingQuestionCard from '$lib/components/grounding-question-card.svelte'
  import TellTheBrain from '$lib/components/tell-the-brain.svelte'
  import * as AlertDialog from '$lib/components/ui/alert-dialog'
  import { Button } from '$lib/components/ui/button'
  import { fetchEnrichPendingSnapshot } from '$lib/graph/poll-graph-enrich-refresh'
  import { BRAIN_KNOWS_LIMIT, BRAIN_KNOWS_POLL_MS } from '$lib/memory/brain-knows'
  import {
    appendViewToSearchParams,
    viewToListApiParams,
    type CurrentUserView,
  } from '$lib/memory/current-user-view'
  import { m } from '$lib/paraglide/messages.js'
  import { docTitle } from '$lib/shell/title'
  import {
    getCurrentUserView,
    subscribeCurrentUserView,
  } from '$lib/stores/current-user-view.svelte'
  import { unlinkTextFileFromThought } from '$lib/text-files/api'

  /**
   * Memory › What the brain knows (plan/concept-memory-one-door.md §2.2): a
   * read-only list of everything the brain took in, newest first, with where
   * it came from and whether it is indexed yet; Retry, Delete and the detail
   * on expand. Nothing is typed in here — the Ask bar is the one door
   * (TellTheBrain points to it). The list polls, so what the assistant files
   * while the page is open shows up and its indexing status moves on.
   */
  let { data }: { data: PageData } = $props()

  const showOnboarding = $derived(!data.onboardingCompleted)

  type CheckInQuestionPayload =
    | { kind: 'grounding'; facetKey: string; question: string }
    | {
        kind: 'relevance'
        thoughtId: string
        snippet: string
        question: string
      }
    | null
  let groundingQuestion = $state<CheckInQuestionPayload>(null)
  let groundingQuestionDismissed = $state(false)
  let groundingQuestionLoading = $state(false)

  function shouldScrollToCheckIn(): boolean {
    const params = page.url.searchParams
    return (
      params.get('checkin') === '1' ||
      params.get('grounding') === '1' ||
      params.get('welcome') === '1'
    )
  }

  function shouldFetchCheckInQuestion(): boolean {
    return data.groundingQuestionEligible || shouldScrollToCheckIn()
  }

  async function fetchGroundingQuestion() {
    if (!shouldFetchCheckInQuestion() || groundingQuestionDismissed || groundingQuestionLoading) {
      return
    }
    groundingQuestionLoading = true
    try {
      const res = await fetch('/api/grounding/question', { cache: 'no-store' })
      if (!res.ok) return
      const payload = (await res.json()) as {
        question?: {
          kind?: 'grounding' | 'relevance'
          facetKey?: string
          thoughtId?: string
          snippet?: string
          question?: string
        } | null
      }
      const q = payload.question
      if (!q?.question) {
        groundingQuestion = null
        return
      }
      if (q.kind === 'relevance' && q.thoughtId && q.snippet) {
        groundingQuestion = {
          kind: 'relevance',
          thoughtId: q.thoughtId,
          snippet: q.snippet,
          question: q.question,
        }
      } else if (q.facetKey) {
        groundingQuestion = {
          kind: 'grounding',
          facetKey: q.facetKey,
          question: q.question,
        }
      } else {
        groundingQuestion = null
      }
      if (groundingQuestion && shouldScrollToCheckIn()) {
        queueMicrotask(() => {
          document.getElementById('grounding-question')?.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          })
        })
      }
    } catch {
      // optional card — ignore fetch errors
    } finally {
      groundingQuestionLoading = false
    }
  }

  function dismissGroundingQuestion() {
    groundingQuestionDismissed = true
    groundingQuestion = null
  }

  let recentThoughts = $state<CaptureRecentThoughtSnippet[]>(data.recentThoughts)
  let thoughtDetails = $state<Record<string, CaptureSubmitResult>>(
    Object.fromEntries(data.recentThoughtDetails.map((thought) => [thought.id, thought])),
  )
  let dataView = $state<CurrentUserView>(getCurrentUserView())
  let recentFilter = $state<{ category?: string }>({})

  /** Why the list can't be refreshed (shown, never swallowed); null when the last request worked. */
  let recentSyncError = $state<string | null>(null)

  async function reloadRecentThoughts() {
    try {
      const params = new SvelteURLSearchParams()
      params.set('limit', String(BRAIN_KNOWS_LIMIT))
      appendViewToSearchParams(params, dataView)
      if (recentFilter.category) params.set('category', recentFilter.category)
      const res = await fetch(`/api/capture/recent?${params.toString()}`)
      if (!res.ok) {
        recentSyncError = (await res.text()) || `Failed to load the list (${res.status})`
        return
      }
      recentSyncError = null
      const payload = (await res.json()) as {
        recentThoughts: CaptureRecentThoughtSnippet[]
        recentThoughtDetails: CaptureSubmitResult[]
      }
      recentThoughts = payload.recentThoughts
      thoughtDetails = Object.fromEntries(
        payload.recentThoughtDetails.map((thought) => [thought.id, thought]),
      )
    } catch (e) {
      recentSyncError = e instanceof Error ? e.message : String(e)
    }
  }

  async function handleRecentFilterChange(filter: { category?: string }) {
    recentFilter = filter
    await reloadRecentThoughts()
  }

  let expandedThoughtId = $state<string | null>(null)
  let err = $state<string | null>(null)
  let deletingThoughtId = $state<string | null>(null)
  let deleteDialogOpen = $state(false)
  let deleteTargetId = $state<string | null>(null)
  let retryingThoughtId = $state<string | null>(null)
  let loadingDetailId = $state<string | null>(null)
  const enrichPollCancelByThoughtId = new SvelteMap<string, () => void>()
  let backgroundEnrichingIds = $state<string[]>([])
  const enrichingThoughtIds = $derived(new Set(backgroundEnrichingIds))

  function upsertRecentThought(thought: CaptureSubmitResult) {
    thoughtDetails = { ...thoughtDetails, [thought.id]: thought }
    recentThoughts = upsertRecentThoughtList(recentThoughts, thought, { limit: BRAIN_KNOWS_LIMIT })
  }

  function startBackgroundEnrichPoll(thoughtId: string) {
    enrichPollCancelByThoughtId.get(thoughtId)?.()
    backgroundEnrichingIds = [...new Set([...backgroundEnrichingIds, thoughtId])]
    const cancel = pollUntilEnrichmentComplete({
      thoughtId,
      onUpdate: (thought) => {
        upsertRecentThought(thought)
        if (thought.enrichmentComplete) cancelEnrichPoll(thoughtId)
      },
      onTimeout: () => {
        cancelEnrichPoll(thoughtId)
      },
    })
    enrichPollCancelByThoughtId.set(thoughtId, cancel)
  }

  function cancelEnrichPoll(thoughtId: string) {
    enrichPollCancelByThoughtId.get(thoughtId)?.()
    enrichPollCancelByThoughtId.delete(thoughtId)
    backgroundEnrichingIds = backgroundEnrichingIds.filter((id) => id !== thoughtId)
  }

  function applyRecentCaptureSync(merged: RecentCaptureMergeResult) {
    if (shouldRejectDestructiveRecentSync(recentThoughts, thoughtDetails, merged.snippets)) {
      return
    }
    recentThoughts = merged.snippets
    thoughtDetails = merged.details
    if (expandedThoughtId && !merged.snippets.some((row) => row.id === expandedThoughtId)) {
      expandedThoughtId = null
    }
    for (const thoughtId of merged.newThoughtIds) {
      const thought = merged.details[thoughtId]
      if (thought && !thought.enrichmentComplete) startBackgroundEnrichPoll(thoughtId)
    }
  }

  function removeRecentThought(thoughtId: string) {
    cancelEnrichPoll(thoughtId)
    recentThoughts = recentThoughts.filter((row) => row.id !== thoughtId)
    const { [thoughtId]: _removed, ...rest } = thoughtDetails
    thoughtDetails = rest
    if (expandedThoughtId === thoughtId) expandedThoughtId = null
  }

  async function refreshThoughtDetail(thoughtId: string) {
    const thought = await fetchCaptureResult(thoughtId)
    thoughtDetails = { ...thoughtDetails, [thoughtId]: thought }
    return thought
  }

  async function expandThought(thoughtId: string) {
    err = null
    expandedThoughtId = thoughtId
    if (thoughtDetails[thoughtId]) return
    loadingDetailId = thoughtId
    try {
      await refreshThoughtDetail(thoughtId)
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
      logErrorToServer(err, 'brain_knows_expand', e)
      if (expandedThoughtId === thoughtId) expandedThoughtId = null
    } finally {
      if (loadingDetailId === thoughtId) loadingDetailId = null
    }
  }

  function collapseThought(thoughtId: string) {
    if (expandedThoughtId === thoughtId) expandedThoughtId = null
  }

  function openDeleteDialog(thoughtId: string) {
    err = null
    deleteTargetId = thoughtId
    deleteDialogOpen = true
  }

  async function confirmDeleteThought() {
    if (!deleteTargetId) return
    const thoughtId = deleteTargetId
    err = null
    deletingThoughtId = thoughtId
    try {
      await deleteCaptureThought(thoughtId)
      captureEvent('thought_deleted', { thought_id: thoughtId })
      removeRecentThought(thoughtId)
      deleteDialogOpen = false
      deleteTargetId = null
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    } finally {
      if (deletingThoughtId === thoughtId) deletingThoughtId = null
    }
  }

  async function unlinkAttachedFile(thoughtId: string, fileId: string) {
    err = null
    try {
      await unlinkTextFileFromThought(thoughtId, fileId)
      await refreshThoughtDetail(thoughtId)
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    }
  }

  async function retryEnrichThought(thoughtId: string) {
    err = null
    retryingThoughtId = thoughtId
    try {
      await retryCaptureEnrich(thoughtId)
      startBackgroundEnrichPoll(thoughtId)
      upsertRecentThought(await fetchCaptureResult(thoughtId))
    } catch (e) {
      err = e instanceof Error ? e.message : String(e)
    } finally {
      if (retryingThoughtId === thoughtId) retryingThoughtId = null
    }
  }

  onMount(() => {
    if (shouldFetchCheckInQuestion()) void fetchGroundingQuestion()

    // The server load cannot read the client-side view selection (localStorage), so the
    // prefetched list is unfiltered; this reload makes the shown list follow the view.
    void reloadRecentThoughts()
    void fetchEnrichPendingSnapshot().catch(() => {
      // Best-effort: kick the tier-2 worker for pending/stale rows after a reload.
    })
    for (const thought of Object.values(thoughtDetails)) {
      if (!thought.enrichmentComplete) startBackgroundEnrichPoll(thought.id)
    }

    const cancelRecentSync = pollCaptureRecentSync({
      limit: BRAIN_KNOWS_LIMIT,
      pollMs: BRAIN_KNOWS_POLL_MS,
      getFilter: () => ({ ...recentFilter, ...viewToListApiParams(dataView) }),
      getState: () => ({ snippets: recentThoughts, details: thoughtDetails }),
      onSync: applyRecentCaptureSync,
      onError: (message) => {
        recentSyncError = message
      },
    })

    // Reload when the global current-user view changes (the initial echo is skipped:
    // mount already reloaded with the active view above).
    let previousView: CurrentUserView | null = null
    const unsubscribeView = subscribeCurrentUserView((view) => {
      const refetch = shouldRefetchRecentForViewChange(previousView, view)
      previousView = view
      dataView = view
      if (refetch) void reloadRecentThoughts()
    })

    return () => {
      cancelRecentSync()
      unsubscribeView()
      for (const cancel of enrichPollCancelByThoughtId.values()) cancel()
      enrichPollCancelByThoughtId.clear()
    }
  })
</script>

<svelte:head><title>{docTitle(m.memory_tab_knows(), 'Memory')}</title></svelte:head>

<div
  class="flex min-h-[70dvh] w-full max-w-4xl flex-1 flex-col overflow-hidden overscroll-none pt-6 sm:px-3"
  data-testid="brain-knows"
>
  <div class="relative z-10 shrink-0 space-y-4 bg-background px-5">
    <TellTheBrain />
    {#if groundingQuestion && !groundingQuestionDismissed}
      {#if groundingQuestion.kind === 'relevance'}
        <GroundingQuestionCard
          kind="relevance"
          thoughtId={groundingQuestion.thoughtId}
          snippet={groundingQuestion.snippet}
          question={groundingQuestion.question}
          onDismiss={dismissGroundingQuestion}
          onSaved={dismissGroundingQuestion}
        />
      {:else}
        <GroundingQuestionCard
          kind="grounding"
          facetKey={groundingQuestion.facetKey}
          question={groundingQuestion.question}
          onDismiss={dismissGroundingQuestion}
          onSaved={dismissGroundingQuestion}
        />
      {/if}
    {/if}
  </div>

  <div class="relative z-0 flex min-h-0 flex-1 flex-col overflow-hidden px-5 pt-6">
    {#if recentSyncError}
      <ErrorNotice
        class="mb-3"
        error={`${m.memory_knows_refresh_error()} ${recentSyncError}`}
        attempted="Refreshing the list on Memory › What the brain knows (/m/memory/capture)"
      />
    {/if}
    {#if err}
      <ErrorNotice
        class="mb-3"
        error={err}
        attempted="Opening, retrying or deleting a thought on Memory › What the brain knows (/m/memory/capture)"
      />
    {/if}
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <CaptureRecentThoughts
        thoughts={recentThoughts}
        {thoughtDetails}
        {enrichingThoughtIds}
        expandedId={expandedThoughtId}
        deletingId={deletingThoughtId}
        retryingId={retryingThoughtId}
        {loadingDetailId}
        limit={BRAIN_KNOWS_LIMIT}
        onExpand={expandThought}
        onCollapse={collapseThought}
        onDelete={openDeleteDialog}
        onUnlinkFile={(thoughtId, fileId) => void unlinkAttachedFile(thoughtId, fileId)}
        onNoteUpdated={(thoughtId) => void refreshThoughtDetail(thoughtId)}
        onRetry={(id) => void retryEnrichThought(id)}
        onFilterChange={handleRecentFilterChange}
      />
    </div>
  </div>
</div>

{#if showOnboarding}
  <CaptureOnboardingOverlay open={true} />
{/if}

<AlertDialog.Root
  bind:open={deleteDialogOpen}
  onOpenChange={(open) => {
    if (!open && !deletingThoughtId) deleteTargetId = null
  }}
>
  <AlertDialog.Content class="max-w-sm" data-testid="brain-knows-delete-confirm">
    <AlertDialog.Header>
      <AlertDialog.Title>{m.memory_knows_delete_title()}</AlertDialog.Title>
      <AlertDialog.Description>{m.memory_knows_delete_body()}</AlertDialog.Description>
    </AlertDialog.Header>
    <AlertDialog.Footer>
      <AlertDialog.Cancel disabled={deletingThoughtId !== null}>
        {m.memory_knows_cancel()}
      </AlertDialog.Cancel>
      <Button
        type="button"
        variant="destructive"
        disabled={deletingThoughtId !== null}
        onclick={() => void confirmDeleteThought()}
      >
        {deletingThoughtId ? m.memory_knows_deleting() : m.memory_knows_delete()}
      </Button>
    </AlertDialog.Footer>
  </AlertDialog.Content>
</AlertDialog.Root>
