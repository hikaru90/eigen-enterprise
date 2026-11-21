<script lang="ts">
  import CalendarDays from '@lucide/svelte/icons/calendar-days'
  import X from '@lucide/svelte/icons/x'
  import { Button } from '$lib/components/ui/button'
  import * as Popover from '$lib/components/ui/popover'
  import { parseNLDateRange, formatDateParam, formatDateRange } from '$lib/utils/date-utils'
  import DictationField from '$lib/voice/dictation-field.svelte'

  let {
    from,
    to,
    onChange,
  }: { from?: string; to?: string; onChange?: (from: string | null, to: string | null) => void } =
    $props()

  let open = $state(false)
  let query = $state('')
  let queryEl = $state<HTMLInputElement | null>(null)
  let parseError = $state('')

  const rangeLabel = $derived(formatDateRange(from, to))

  function applyDates(f?: string, t?: string) {
    parseError = ''
    onChange?.(f ?? null, t ?? null)
    open = false
  }

  function handleSubmit() {
    if (!query.trim()) return
    const result = parseNLDateRange(query)
    if (!result) {
      parseError = "Couldn't parse that. Try e.g. 'last monday to today'."
      return
    }
    parseError = ''
    applyDates(formatDateParam(result.from), formatDateParam(result.to))
  }

  function preset(expr: string) {
    const r = parseNLDateRange(expr)
    if (r) applyDates(formatDateParam(r.from), formatDateParam(r.to))
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1.5 text-xs transition-colors"
    aria-label="Filter by date range"
  >
    <span>{rangeLabel}</span>
    <CalendarDays class="size-3.5 shrink-0" />
  </Popover.Trigger>
  <Popover.Content align="end" class="w-64 p-3">
    <div class="flex flex-col gap-2">
      <div class="relative">
        <DictationField field={queryEl} kind="input" testid="date-range-voice">
          <input
            bind:this={queryEl}
            type="text"
            bind:value={query}
            placeholder="e.g. last monday to today"
            aria-label="Date range in your words"
            class="w-full rounded border border-border bg-background py-1.5 pr-9 pl-2 text-xs outline-none focus:border-blue-500"
            onkeydown={(e) => {
              if (e.key === 'Enter') handleSubmit()
            }}
          />
        </DictationField>
        {#if parseError}
          <p class="mt-1 text-xs text-red-500">{parseError}</p>
        {/if}
      </div>

      <div class="flex flex-wrap gap-1">
        <Button size="xs" variant="outline" onclick={() => preset('last week')}>Last Week</Button>
        <Button size="xs" variant="outline" onclick={() => preset('last month')}>Last Month</Button>
        <Button size="xs" variant="outline" onclick={() => applyDates()}>Overall</Button>
      </div>

      {#if from || to}
        <button
          type="button"
          onclick={() => applyDates()}
          class="text-muted-foreground hover:text-foreground inline-flex cursor-pointer items-center gap-1 text-xs transition-colors"
        >
          <X class="size-3" />
          Clear dates
        </button>
      {/if}

      {#if rangeLabel !== 'All time'}
        <p class="text-muted-foreground border-t border-border pt-2 text-xs">
          Current: {rangeLabel}
        </p>
      {/if}
    </div>
  </Popover.Content>
</Popover.Root>
