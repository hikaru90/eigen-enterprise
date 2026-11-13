<script lang="ts">
  import type { AssistantController } from './assistant-controller.svelte'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import { onMount } from 'svelte'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'

  /**
   * The Activity tab: the readable log of what the assistant and the system
   * did (GET /api/assistant/activity, the same lines as /assistant/activity),
   * grouped by day, newest first.
   */
  let { assistant }: { assistant: AssistantController } = $props()

  type LogEntry = {
    id: string
    ts: string
    actor: string
    text: string
    moduleLabel: string
    outcome: 'done' | 'failed' | null
  }
  type LogDay = { day: string; entries: LogEntry[] }

  let log = $state<LogDay[] | null>(null)
  let failed = $state(false)

  const dayFormat = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  })
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
  /** Days group in UTC (server); the label names that UTC day. */
  const dayLabel = (day: string) => dayFormat.format(new Date(`${day}T12:00:00Z`))
  const timeLabel = (iso: string) => timeFormat.format(new Date(iso))

  async function load(): Promise<void> {
    failed = false
    try {
      const res = await assistant.fetch('/api/assistant/activity', {
        headers: { accept: 'application/json' },
      })
      if (!res.ok) throw new Error(`activity load failed: HTTP ${res.status}`)
      log = ((await res.json()) as { log: LogDay[] }).log
    } catch (err) {
      console.error('[assistant] activity load failed', err)
      failed = true
    }
  }

  onMount(() => {
    void load()
  })
</script>

<div class="flex min-h-0 flex-1 flex-col" data-testid="assistant-activity">
  <div class="flex shrink-0 items-center justify-between gap-2 px-4 pt-3 pb-2">
    <p class="text-xs text-muted-foreground">What the assistant and the system did.</p>
    <a
      href={resolve('/assistant/activity')}
      class="text-xs font-medium text-foreground/70 hover:text-foreground hover:underline"
      data-testid="assistant-activity-all">Open as page</a
    >
  </div>
  <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
    {#if failed}
      <div
        class="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
      >
        <span class="text-foreground/70">The activity did not load.</span>
        <Button size="sm" variant="outline" onclick={() => void load()}>Try again</Button>
      </div>
    {:else if log === null}
      <div class="flex justify-center py-6">
        <LoaderCircle class="size-4 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    {:else if log.length === 0}
      <p class="rounded-md border border-border px-3 py-3 text-sm text-foreground/60">
        Nothing has happened yet.
      </p>
    {:else}
      <div class="flex flex-col gap-5">
        {#each log as group (group.day)}
          <section aria-label={dayLabel(group.day)} data-testid="assistant-activity-day">
            <h3 class="mb-1.5 text-xs font-medium text-foreground/60">{dayLabel(group.day)}</h3>
            <ol class="flex flex-col gap-2 border-l border-border pl-3">
              {#each group.entries as entry (entry.id)}
                <li class="relative min-w-0 text-sm" data-testid="assistant-activity-entry">
                  <span
                    class="absolute top-1.5 -left-[15.5px] size-1.5 rounded-full {entry.outcome ===
                    'failed'
                      ? 'bg-destructive'
                      : 'bg-foreground/35'}"
                    aria-hidden="true"
                  ></span>
                  <p class="leading-snug wrap-break-word">
                    <span class="font-medium">{entry.actor}</span>
                    <span class="text-foreground/80">· {entry.text}</span>
                    {#if entry.outcome === 'failed'}<span class="text-xs text-destructive">
                        · didn't work</span
                      >{/if}
                  </p>
                  <p class="text-xs text-muted-foreground">
                    <time datetime={entry.ts}>{timeLabel(entry.ts)}</time> · {entry.moduleLabel}
                  </p>
                </li>
              {/each}
            </ol>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</div>
