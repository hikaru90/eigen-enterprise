<script lang="ts">
  import SparklesIcon from '@lucide/svelte/icons/sparkles'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, formatSize, type ArchiveSuggestions } from '$lib/drive/api'
  import { shortWhen } from '$lib/drive/display'

  /**
   * "Suggest what to archive": the person picks how long a file must have
   * gone unchanged, the AI (server side, through the gateway) judges which of
   * those files look done with and says why, and the person unticks what
   * they want to keep in view. Nothing is archived until they confirm.
   */
  let {
    days,
    onclose,
    ondone,
  }: {
    /** The cut-off offered first (the server's default). */
    days: number
    onclose: () => void
    /** After archiving: the sentence to show. */
    ondone: (message: string) => void
  } = $props()

  const AGES: Array<{ days: number; label: string }> = [
    { days: 90, label: '3 months' },
    { days: 180, label: '6 months' },
    { days: 365, label: '1 year' },
    { days: 730, label: '2 years' },
  ]
  const labelOf = (d: number) => AGES.find((a) => a.days === d)?.label ?? `${d} days`

  // The picker starts at the server's default; a later change of the prop is not a reset.
  // svelte-ignore state_referenced_locally
  let age = $state(String(days))
  let asking = $state(false)
  let archiving = $state(false)
  let error = $state<string | null>(null)
  let result = $state<ArchiveSuggestions | null>(null)
  let ticked = $state<Record<string, boolean>>({})

  const chosen = $derived(result ? result.suggestions.filter((s) => ticked[s.file.id]) : [])
  const where = (s: ArchiveSuggestions['suggestions'][number]) =>
    [s.root.label, ...s.path.map((c) => c.name)].join(' / ')
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`

  const summary = $derived.by(() => {
    if (!result) return ''
    const span = labelOf(result.olderThanDays)
    if (result.considered === 0) return 'No file you can edit has gone unchanged that long.'
    if (result.suggestions.length === 0)
      return `The AI looked at ${files(result.considered)} unchanged for ${span} and suggests keeping all of them in view.`
    return `The AI suggests ${result.suggestions.length} of ${files(result.considered)} unchanged for ${span}${
      result.more ? ' (the longest unchanged; ask again later for the rest)' : ''
    }. Untick what you want to keep in view.`
  })

  async function ask() {
    error = null
    result = null
    asking = true
    try {
      const out = await driveApi.suggestArchive(Number(age))
      ticked = Object.fromEntries(out.suggestions.map((s) => [s.file.id, true]))
      result = out
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      asking = false
    }
  }

  async function confirm() {
    if (chosen.length === 0) return
    error = null
    archiving = true
    try {
      const out = await driveApi.archiveMany(chosen.map((s) => ({ type: 'file', id: s.file.id })))
      await invalidateAll()
      const failed = out.errors.map((e) => e.error).join(' ')
      ondone(`Archived ${files(out.archived.length)}.${failed ? ` ${failed}` : ''}`)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      archiving = false
    }
  }
</script>

<section
  class="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
  aria-label="Suggest what to archive"
  data-testid="drive-suggest-panel"
>
  <div class="flex flex-wrap items-center gap-2 text-sm">
    <SparklesIcon class="size-4 text-primary" aria-hidden="true" />
    <label for="drive-suggest-age" class="font-medium">Look at files I can edit, unchanged for</label>
    <select
      id="drive-suggest-age"
      class="h-8 rounded-md border border-input bg-background px-2 text-sm"
      bind:value={age}
      disabled={asking || archiving}
      data-testid="drive-suggest-age"
    >
      {#each AGES as a (a.days)}
        <option value={String(a.days)}>{a.label}</option>
      {/each}
    </select>
    <Button size="sm" onclick={ask} disabled={asking || archiving} data-testid="drive-suggest-run">
      {asking ? 'Looking…' : result ? 'Ask again' : 'Suggest'}
    </Button>
    <Button size="sm" variant="ghost" onclick={onclose} data-testid="drive-suggest-close">Close</Button>
  </div>
  <p class="text-xs text-muted-foreground">
    The AI sees each file’s name, folder, type, size and dates — not its content. It only suggests:
    nothing is archived until you confirm, and archived files can be brought back any time.
  </p>

  {#if error}
    <p
      class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      role="alert"
      data-testid="drive-suggest-error"
    >
      {error}
    </p>
  {/if}

  {#if result}
    <p class="text-sm" data-testid="drive-suggest-summary">{summary}</p>
    {#if result.suggestions.length > 0}
      <ul class="flex flex-col divide-y divide-border/60 rounded-md border border-border">
        {#each result.suggestions as s (s.file.id)}
          <li class="flex items-start gap-3 px-3 py-2.5 text-sm" data-testid="drive-suggestion">
            <input
              type="checkbox"
              class="mt-1 size-4 shrink-0"
              bind:checked={ticked[s.file.id]}
              aria-label={`Archive ${s.file.name}`}
            />
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <a
                  class="truncate font-medium hover:underline"
                  href={resolve(`/drive/file/${s.file.id}`)}
                  target="_blank"
                  rel="noopener noreferrer">{s.file.name}</a
                >
                <span class="text-xs text-muted-foreground"
                  >{where(s)} · changed {shortWhen(s.file.updatedAt)} · {formatSize(s.file.size)}</span
                >
              </span>
              <span class="text-muted-foreground">{s.reason}</span>
            </div>
          </li>
        {/each}
      </ul>
      <div class="flex items-center gap-2">
        <Button
          size="sm"
          onclick={confirm}
          disabled={archiving || chosen.length === 0}
          data-testid="drive-suggest-confirm">Archive {files(chosen.length)}</Button
        >
        <Button size="sm" variant="outline" onclick={onclose} disabled={archiving}>Keep all</Button>
      </div>
    {/if}
  {/if}
</section>
