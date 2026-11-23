<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { costLabel, statusLabel, triggerLabel, type RunItem } from './run-format'

  /**
   * A co-worker's run log on its profile (plan/phase-ai-coworkers.md C6), from
   * coworkers.runs: what started each turn, how it ended (and why it stopped),
   * what it cost, when — and a link to the thread or the task. A run somewhere
   * the reader may not look says so instead of linking.
   */
  let { runs }: { runs: RunItem[] } = $props()

  const timeFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
</script>

<section class="rounded-lg border border-border bg-card p-4" aria-labelledby="run-log" data-testid="run-log">
  <h3 id="run-log" class="text-sm font-semibold">{m.coworkers_runs_heading()}</h3>
  <p class="mt-0.5 text-xs text-muted-foreground">{m.coworkers_runs_intro()}</p>
  {#if runs.length === 0}
    <p class="mt-3 text-sm text-muted-foreground" data-testid="run-log-empty">{m.coworkers_runs_empty()}</p>
  {:else}
    <ul class="mt-3 divide-y divide-border text-sm">
      {#each runs as r (r.id)}
        <li class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2" data-testid="run" data-status={r.status} data-trigger={r.triggerKind}>
          <span class="min-w-0">
            <span class="font-medium">{triggerLabel(r.triggerKind)}</span>
            <span class="text-muted-foreground"> · <span data-testid="run-status">{statusLabel(r)}</span></span>
          </span>
          <span class="flex flex-wrap items-baseline gap-x-3 text-muted-foreground">
            <span class="tabular-nums" data-testid="run-cost">{costLabel(r.costUsd)}</span>
            <time datetime={r.triggeredAt}>{timeFormat.format(new Date(r.triggeredAt))}</time>
            {#if r.threadUrl}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server-built link with its query (coworkers.runs threadUrl) -->
              <a class="text-foreground underline-offset-4 hover:underline" href={r.threadUrl} data-testid="run-link">{m.coworkers_run_open_thread()}</a>
            {:else if r.taskUrl}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a server-built link with its hash (coworkers.runs taskUrl) -->
              <a class="text-foreground underline-offset-4 hover:underline" href={r.taskUrl} data-testid="run-link">{m.coworkers_run_open_task()}</a>
            {:else if r.hidden}
              <span data-testid="run-hidden">{r.triggerKind === 'assignment' ? m.coworkers_run_hidden_task() : m.coworkers_run_hidden()}</span>
            {/if}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
