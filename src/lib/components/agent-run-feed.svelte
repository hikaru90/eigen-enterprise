<script lang="ts">
  import type { FeedLine, FeedState, RunConnection } from '$lib/agent-runs/feed'
  import { Badge } from '$lib/components/ui/badge'

  /** The D8 live feed of one durable run (pure render of the folded feed state). */
  let { feed, connection }: { feed: FeedState; connection: RunConnection } = $props()

  const statusLabel = $derived.by(() => {
    if (connection === 'connecting') return 'Connecting'
    if (connection === 'lost') return 'Disconnected — reconnecting'
    if (connection === 'ended') return 'Stream ended'
    return feed.running ? 'Running' : 'Idle'
  })

  const toolStatus: Record<FeedLine['status'], string> = {
    running: 'running',
    done: 'done',
    error: 'failed',
    unfinished: 'not finished',
  }

  function argsPreview(args: unknown): string {
    if (args === undefined) return ''
    const text = JSON.stringify(args)
    if (text === '{}') return ''
    return text.length > 160 ? `${text.slice(0, 159)}…` : text
  }
</script>

<section class="min-w-0">
  <div class="flex items-center justify-between gap-3">
    <h2 class="text-[13px] font-medium">Live events</h2>
    <span
      class="inline-flex items-center gap-1.5 text-xs text-foreground/60"
      data-testid="run-feed-status"
    >
      <span
        class={[
          'size-1.5 rounded-full',
          connection === 'live' && feed.running
            ? 'animate-pulse bg-eigen-green'
            : connection === 'live'
              ? 'bg-eigen-green'
              : 'bg-foreground/30',
        ]}
        aria-hidden="true"
      ></span>
      {statusLabel}
    </span>
  </div>

  <ol
    role="log"
    aria-label="Run events"
    aria-live="polite"
    class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border"
  >
    {#each feed.lines as line (line.key)}
      {#if line.kind === 'run'}
        <li class="px-4 py-1.5 text-xs text-foreground/50" data-testid="run-feed-marker">
          {line.text}
        </li>
      {:else if line.kind === 'error'}
        <li class="px-4 py-2.5 text-sm text-destructive" data-testid="run-feed-error">
          <span class="mr-2 text-xs">Error</span>
          <span class="break-words whitespace-pre-wrap">{line.text}</span>
        </li>
      {:else if line.kind === 'user'}
        <li class="px-4 py-2.5 text-sm" data-testid="run-feed-user">
          <span class="mr-2 text-xs text-foreground/50">Input</span>
          <span class="break-words whitespace-pre-wrap">{line.text}</span>
        </li>
      {:else if line.kind === 'assistant'}
        <li class="px-4 py-2.5 text-sm" data-testid="run-feed-assistant">
          <span class="mr-2 text-xs text-foreground/50">Agent</span>
          <span class="break-words whitespace-pre-wrap">{line.text}</span>
          {#if line.status === 'running'}<span
              class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/40 align-middle"
              aria-hidden="true"
            ></span>{/if}
        </li>
      {:else}
        <li class="flex min-w-0 flex-col gap-0.5 px-4 py-2 text-sm" data-testid="run-feed-tool">
          <span class="flex min-w-0 items-center gap-2">
            <span class="text-xs text-foreground/50">Tool</span>
            <code class="truncate font-mono text-[13px]">{line.text}</code>
            <Badge variant={line.status === 'error' ? 'destructive' : 'secondary'}>
              {toolStatus[line.status]}
            </Badge>
          </span>
          {#if argsPreview(line.args)}
            <code class="truncate font-mono text-xs text-foreground/50">{argsPreview(line.args)}</code>
          {/if}
        </li>
      {/if}
    {:else}
      <li class="px-4 py-3 text-sm text-foreground/55">No events yet.</li>
    {/each}
  </ol>
</section>
