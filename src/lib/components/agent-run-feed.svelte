<script lang="ts">
  import type { FeedLine, FeedState, RunConnection } from '$lib/agent-runs/feed'
  import ChatToolStep from '$lib/components/chat-tool-step.svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { summarizeToolInput, toolStepTarget, type ToolStepStatus } from '$lib/tool-steps/summary'

  /** The D8 live feed of one durable run (pure render of the folded feed state). */
  let { feed, connection }: { feed: FeedState; connection: RunConnection } = $props()

  const statusLabel = $derived.by(() => {
    if (connection === 'connecting') return 'Connecting'
    if (connection === 'lost') return 'Disconnected — reconnecting'
    if (connection === 'ended') return 'Stream ended'
    return feed.running ? 'Running' : 'Idle'
  })

  const toolStatus: Record<FeedLine['status'], ToolStepStatus> = {
    running: 'running',
    done: 'done',
    error: 'failed',
    unfinished: 'stopped',
  }

  /** The step as the chat shows it: the tool that really ran and a secret-free input summary. */
  function step(line: FeedLine): { tool: string; inputSummary: string | null } {
    const target = toolStepTarget(line.text, line.args)
    return { tool: target.tool, inputSummary: summarizeToolInput(target.input) }
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
        <li class="px-4 py-1.5 text-xs text-muted-foreground" data-testid="run-feed-marker">
          {line.text}
        </li>
      {:else if line.kind === 'error'}
        <li class="px-4 py-2.5" data-testid="run-feed-error">
          <ErrorNotice
            class="break-words whitespace-pre-wrap"
            error={line.text}
            agent={{
              attempted: 'Running an agent (the live run feed)',
              ...(line.detail ? { cause: line.detail } : {}),
              nextSteps: [],
            }}
          >
            {#if line.detail}
              <details class="text-xs text-muted-foreground" data-testid="run-feed-error-details">
                <summary class="cursor-pointer">Details</summary>
                <code class="mt-1 block font-mono break-words whitespace-pre-wrap"
                  >{line.detail}</code
                >
              </details>
            {/if}
          </ErrorNotice>
        </li>
      {:else if line.kind === 'user'}
        <li class="px-4 py-2.5 text-sm" data-testid="run-feed-user">
          <span class="mr-2 text-xs text-muted-foreground">Input</span>
          <span class="break-words whitespace-pre-wrap">{line.text}</span>
        </li>
      {:else if line.kind === 'assistant'}
        <li class="px-4 py-2.5 text-sm" data-testid="run-feed-assistant">
          <span class="mr-2 text-xs text-muted-foreground">Agent</span>
          <span class="break-words whitespace-pre-wrap">{line.text}</span>
          {#if line.status === 'running'}<span
              class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-foreground/40 align-middle"
              aria-hidden="true"
            ></span>{/if}
        </li>
      {:else}
        {@const shown = step(line)}
        <li class="min-w-0 px-3 py-1" data-testid="run-feed-tool">
          <ChatToolStep
            tool={shown.tool}
            status={toolStatus[line.status]}
            inputSummary={shown.inputSummary}
            showResult={false}
            testid="run-feed-tool-step"
          />
        </li>
      {/if}
    {:else}
      <li class="px-4 py-3 text-sm text-muted-foreground">No events yet.</li>
    {/each}
  </ol>
</section>
