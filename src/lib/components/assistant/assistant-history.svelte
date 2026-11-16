<script lang="ts">
  import type { AssistantController } from './assistant-controller.svelte'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import Pencil from '@lucide/svelte/icons/pencil'
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import type { RunSummary } from '$lib/agent-runs/feed'
  import { Button } from '$lib/components/ui/button'
  import RunTitleEditor from './run-title-editor.svelte'

  /**
   * The History tab: every conversation the assistant had (the durable runs,
   * GET /api/agent/runs), newest activity first. A conversation opens its
   * linkable run view at /assistant/[id].
   */
  let { assistant }: { assistant: AssistantController } = $props()

  let runs = $state<RunSummary[] | null>(null)
  let failed = $state<string | null>(null)

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => dateFormat.format(new Date(iso))

  async function load(): Promise<void> {
    failed = null
    try {
      const res = await assistant.fetch('/api/agent/runs', {
        headers: { accept: 'application/json' },
      })
      if (res.status === 403) {
        failed = 'Only members of the company can see its conversations.'
        return
      }
      if (!res.ok) throw new Error(`runs load failed: HTTP ${res.status}`)
      runs = ((await res.json()) as { runs: RunSummary[] }).runs
    } catch (err) {
      console.error('[assistant] history load failed', err)
      failed = 'The conversations did not load.'
    }
  }

  /** A rename keeps the list order (it is not activity); only the title changes. */
  function renamed(run: RunSummary): void {
    if (runs) runs = runs.map((r) => (r.id === run.id ? run : r))
  }

  onMount(() => {
    void load()
  })
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="assistant-history">
  <div class="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
    <p class="text-xs text-muted-foreground">Every conversation, newest first.</p>
    <a
      href={resolve('/assistant')}
      class="text-xs font-medium text-foreground/70 hover:text-foreground hover:underline"
      data-testid="assistant-history-all">Open as page</a
    >
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
    {#if failed}
      <div
        class="mx-2 flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
      >
        <span class="text-foreground/70">{failed}</span>
        <Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button>
      </div>
    {:else if runs === null}
      <div class="flex justify-center py-6">
        <LoaderCircle class="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    {:else if runs.length === 0}
      <div
        class="mx-2 flex flex-col items-start gap-2 rounded-md border border-border px-3 py-3 text-sm"
      >
        <p class="text-foreground/60">No conversations yet.</p>
        <Button size="sm" variant="outline" onclick={() => assistant.newConversation()}
          >Start one</Button
        >
      </div>
    {:else}
      <ul class="flex flex-col gap-px" data-testid="assistant-history-list">
        {#each runs as run (run.id)}
          <li class="group/run flex min-w-0 items-center gap-1">
            <RunTitleEditor
              runId={run.id}
              title={run.title}
              renamable={run.renamable}
              fetch={assistant.fetch}
              onrenamed={renamed}
              inputClass="my-1 ml-1"
            >
              {#snippet display(start)}
                <a
                  href={resolve('/(nucleus)/assistant/[id]', { id: String(run.id) })}
                  class="group flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-sm outline-none hover:bg-primary/[0.05] focus-visible:ring-2 -ring"
                  data-testid="assistant-history-item"
                >
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-medium" data-testid="assistant-history-title"
                      >{run.title}</span
                    >
                    <span class="truncate text-xs text-muted-foreground">
                      <time datetime={run.updatedAt}>{when(run.updatedAt)}</time>
                    </span>
                  </span>
                  <ChevronRight
                    class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                    aria-hidden="true"
                  />
                </a>
                {#if run.renamable}
                  <Button
                    size="icon"
                    variant="ghost"
                    class="size-7 shrink-0 text-muted-foreground hover:text-foreground [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/run:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
                    aria-label="Rename conversation"
                    title="Rename"
                    data-testid="assistant-history-rename"
                    onclick={start}
                  >
                    <Pencil class="size-3.5" aria-hidden="true" />
                  </Button>
                {/if}
              {/snippet}
            </RunTitleEditor>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
