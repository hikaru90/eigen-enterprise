<script lang="ts">
  import type { SubmitFunction } from '@sveltejs/kit'
  import { enhance } from '$app/forms'
  import type { PatternToolView } from '$lib/kernel/pattern-tools'

  /**
   * What's happening (wish 75a4e570): the company brain's digest of who changed how much
   * where over the last 7 days, and what recurs — observations, never evaluations. A client of
   * dashboard.patterns (the read the page loads) and dashboard.patterns_refresh (Refresh posts
   * the page's ?/patternsRefresh action, which runs the tool as the signed-in person).
   */
  let { patterns, action = '?/patternsRefresh' }: { patterns: PatternToolView; action?: string } = $props()

  let refreshing = $state(false)
  let error = $state<string | null>(null)

  const onRefresh: SubmitFunction = () => {
    refreshing = true
    error = null
    return async ({ result, update }) => {
      refreshing = false
      if (result.type === 'failure') {
        const message = (result.data as { error?: unknown } | undefined)?.error
        error = typeof message === 'string' ? message : "What's happening could not be refreshed. Try again."
        return
      }
      if (result.type === 'error') {
        error = result.error instanceof Error ? result.error.message : String(result.error)
        return
      }
      await update()
    }
  }

  const since = $derived(
    patterns.createdAt
      ? new Date(patterns.createdAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : null,
  )
</script>

<section class="stage stage-stone h-full min-h-80" aria-label="What's happening" data-testid="dashboard-patterns">
  <span class="stage-tag">Company</span>
  <div class="flex w-full max-w-[19.5rem] flex-col overflow-hidden rounded-[1.75rem] bg-white p-2.5 text-[#111111]">
    <div class="flex min-w-0 items-center gap-3 rounded-[1.25rem] bg-black/5 py-2 pr-2 pl-3">
      <h2 class="min-w-0 flex-1 truncate text-sm font-medium">What's happening</h2>
      <form method="POST" {action} use:enhance={onRefresh}>
        <button
          type="submit"
          class="chip h-7 shrink-0 bg-black/5 px-3 outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          disabled={refreshing}
          data-testid="dashboard-patterns-refresh">{refreshing ? 'Refreshing…' : 'Refresh'}</button
        >
      </form>
    </div>
    {#if patterns.items.length === 0}
      <p class="px-2 pt-4 pb-3 font-mono text-[13px]" data-testid="dashboard-patterns-empty">
        {patterns.digestId ? 'Nothing you can see happened in the last 7 days.' : 'No digest yet. The brain writes one daily.'}
      </p>
    {:else}
      <ul class="fade-end mt-2 flex max-h-52 flex-col gap-1.5 overflow-y-auto px-2 pb-8" data-testid="dashboard-patterns-items">
        {#each patterns.items as item (item.id)}
          <li class="font-mono text-[13px] leading-snug wrap-break-word" data-testid="dashboard-patterns-item">
            {#if item.kind === 'recurring'}<span class="mr-1 rounded-full bg-(--tone-yellow) px-1.5">recurring</span>{/if}{item.text}
          </li>
        {/each}
      </ul>
    {/if}
    {#if since}
      <p class="px-2 pb-1 text-[13px] text-black/50">Written {since}</p>
    {/if}
    {#if error}
      <p class="px-2 pb-1 text-[13px] text-[#a8321a]" role="alert" data-testid="dashboard-patterns-error">{error}</p>
    {/if}
  </div>
</section>
