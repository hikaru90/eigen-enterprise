<script lang="ts">
  import type { ImportCandidate } from '../types'
  import { enhance } from '$app/forms'
  import { Button } from '$lib/components/ui/button'
  import { Label } from '$lib/components/ui/label'
  import {
    CSV_SEPARATORS,
    CSV_TARGETS,
    checkMapping,
    columnCount,
    csvCandidates,
    parseCsv,
    parseVcards,
    type CsvSeparator,
    type CsvTarget,
  } from '../import'
  import { IMPORT_MAX } from '../types'

  /**
   * Import, step 1: pick a vCard (.vcf) or CSV file. It is read here, in the
   * browser. A CSV's columns mean what you say they mean: for each column,
   * pick what it holds (nothing is guessed from its header). "Check" sends
   * the people read to the server for a preview — nothing is saved yet.
   */
  let { action = '?/preview', error = null }: { action?: string; error?: string | null } = $props()

  type Loaded = { kind: 'vcard' | 'csv'; name: string; text: string }

  let file = $state<Loaded | null>(null)
  let readError = $state<string | null>(null)
  let separator = $state<CsvSeparator>(',')
  let headerRow = $state(true)
  let mapping = $state<CsvTarget[]>([])

  const csvRows = $derived.by((): { rows: string[][]; error: string | null } => {
    if (file?.kind !== 'csv') return { rows: [], error: null }
    try {
      return { rows: parseCsv(file.text, separator), error: null }
    } catch (err) {
      return { rows: [], error: err instanceof Error ? err.message : String(err) }
    }
  })
  const columns = $derived(columnCount(csvRows.rows))
  /** One target per column (a column you haven't mapped yet is left out). */
  const targets = $derived(Array.from({ length: columns }, (_, i) => mapping[i] ?? 'ignore'))
  const sample = $derived(headerRow ? csvRows.rows.slice(1, 4) : csvRows.rows.slice(0, 3))

  const read = $derived.by((): { candidates: ImportCandidate[]; problems: string[] } => {
    if (!file) return { candidates: [], problems: [] }
    try {
      if (file.kind === 'vcard') return { candidates: parseVcards(file.text), problems: [] }
      if (csvRows.error) return { candidates: [], problems: [csvRows.error] }
      const problems = checkMapping(targets)
      if (problems.length > 0) return { candidates: [], problems }
      return { candidates: csvCandidates(csvRows.rows, targets, { headerRow }), problems: [] }
    } catch (err) {
      return { candidates: [], problems: [err instanceof Error ? err.message : String(err)] }
    }
  })
  const tooMany = $derived(read.candidates.length > IMPORT_MAX)

  /** The format is the file's own type: its extension (.vcf/.vcard or .csv/.tsv/.txt). */
  function kindOf(name: string): Loaded['kind'] | null {
    const ext = name.toLowerCase().split('.').pop() ?? ''
    if (ext === 'vcf' || ext === 'vcard') return 'vcard'
    if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return 'csv'
    return null
  }

  async function onfile(event: Event): Promise<void> {
    const picked = (event.currentTarget as HTMLInputElement).files?.[0]
    file = null
    readError = null
    mapping = []
    if (!picked) return
    const kind = kindOf(picked.name)
    if (!kind) {
      readError = 'Pick a vCard (.vcf) or CSV (.csv) file.'
      return
    }
    if (kind === 'csv' && picked.name.toLowerCase().endsWith('.tsv')) separator = '\t'
    file = { kind, name: picked.name, text: await picked.text() }
  }

  function header(i: number): string {
    const h = headerRow ? (csvRows.rows[0]?.[i] ?? '').trim() : ''
    return h === '' ? `Column ${i + 1}` : h
  }
</script>

<div class="grid max-w-3xl gap-4" data-testid="import-file">
  <div class="grid gap-1.5">
    <Label for="import-file-input">File</Label>
    <input
      id="import-file-input"
      type="file"
      accept=".vcf,.vcard,text/vcard,.csv,.tsv,.txt,text/csv"
      class="text-sm"
      onchange={onfile}
      data-testid="import-file-input"
    />
    <p class="text-xs text-muted-foreground">A vCard (.vcf, from your phone or address book) or a CSV table (.csv). Read here; nothing is saved yet.</p>
    {#if readError}<p class="text-sm text-destructive" role="alert">{readError}</p>{/if}
  </div>

  {#if file?.kind === 'csv'}
    <fieldset class="grid gap-3 rounded-lg border border-border p-3" data-testid="import-csv-mapping">
      <legend class="px-1 text-sm font-medium">What the columns hold</legend>
      <div class="flex flex-wrap items-center gap-4 text-sm">
        <label class="flex items-center gap-2">
          Columns separated by
          <select class="border-input bg-card h-8 rounded-md border px-2 text-xs" bind:value={separator} aria-label="Columns separated by">
            {#each CSV_SEPARATORS as s (s.value)}<option value={s.value}>{s.label}</option>{/each}
          </select>
        </label>
        <label class="flex items-center gap-2">
          <input type="checkbox" bind:checked={headerRow} />
          The first row holds the column names
        </label>
      </div>
      {#if columns > 0}
        <p class="text-xs text-muted-foreground">For each column, pick what it holds. Columns you leave at “Don’t import” are left out.</p>
        <ul class="grid gap-2">
          {#each targets as target, i (i)}
            <li class="grid gap-1 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-center sm:gap-3" data-testid="import-column">
              <div class="min-w-0 text-sm">
                <span class="font-medium">{header(i)}</span>
                <span class="block truncate text-xs text-muted-foreground"
                  >{sample.map((r) => (r[i] ?? '').trim()).filter((v) => v !== '').join(' · ') || 'empty'}</span
                >
              </div>
              <select
                class="border-input bg-card h-8 rounded-md border px-2 text-xs"
                aria-label={`What “${header(i)}” holds`}
                value={target}
                onchange={(e) => {
                  const next = [...targets]
                  next[i] = (e.currentTarget as HTMLSelectElement).value as CsvTarget
                  mapping = next
                }}
              >
                {#each CSV_TARGETS as t (t.value)}<option value={t.value}>{t.label}</option>{/each}
              </select>
            </li>
          {/each}
        </ul>
      {/if}
    </fieldset>
  {/if}

  {#if file}
    {#if read.problems.length > 0}
      <ul class="grid gap-1 text-sm text-destructive" role="alert" data-testid="import-problems">
        {#each read.problems as p (p)}<li>{p}</li>{/each}
      </ul>
    {:else if tooMany}
      <p class="text-sm text-destructive" role="alert">That’s {read.candidates.length} people; one import adds at most {IMPORT_MAX}. Split the file.</p>
    {/if}
    <form method="POST" {action} use:enhance class="flex flex-wrap items-center gap-3" data-testid="import-check-form">
      <input type="hidden" name="candidates" value={JSON.stringify(read.candidates)} data-testid="import-candidates" />
      <Button type="submit" disabled={read.candidates.length === 0 || tooMany} data-testid="import-check"
        >Check {read.candidates.length} {read.candidates.length === 1 ? 'person' : 'people'}</Button
      >
      <span class="text-xs text-muted-foreground">Shows who is new and who you already have. Nothing is saved yet.</span>
    </form>
  {/if}
  {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
</div>
