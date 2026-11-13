<script lang="ts">
  import type { ImportPreview } from '../types'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { CHANNEL_LABELS } from '../types'

  /**
   * Import, step 2: who would be added. New people are ticked (untick anyone
   * you don't want); people you already have — the same email — are listed
   * and never imported again or changed; rows that can't be imported say
   * why. Nothing is saved until “Import”.
   */
  let { preview, action = '?/import', error = null }: { preview: ImportPreview; action?: string; error?: string | null } = $props()

  /** New rows you unticked. */
  let left = $state<number[]>([])
  let shared = $state(false)

  const newRows = $derived(preview.rows.filter((r) => r.status === 'new'))
  const chosen = $derived(newRows.filter((r) => !left.includes(r.index)))
  const others = $derived(preview.rows.filter((r) => r.status !== 'new'))

  function toggle(index: number, on: boolean): void {
    left = on ? left.filter((i) => i !== index) : [...left, index]
  }
</script>

<div class="grid max-w-3xl gap-4" data-testid="import-preview">
  <p class="text-sm" role="status" data-testid="import-counts">
    {preview.counts.new} new · {preview.counts.duplicate} already in your contacts · {preview.counts.invalid} can’t be imported
  </p>

  {#if newRows.length > 0}
    <ul class="divide-y divide-border rounded-lg border border-border" aria-label="New people">
      {#each newRows as r (r.index)}
        {#if r.status === 'new'}
          <li class="flex items-start gap-3 px-4 py-2.5 text-sm" data-testid="import-new">
            <input
              type="checkbox"
              class="mt-1"
              id={`import-row-${r.index}`}
              checked={!left.includes(r.index)}
              onchange={(e) => toggle(r.index, (e.currentTarget as HTMLInputElement).checked)}
            />
            <label for={`import-row-${r.index}`} class="grid min-w-0 gap-0.5">
              <span class="font-medium">{r.contact.name}</span>
              {#if r.contact.organisation || r.contact.title}
                <span class="text-xs text-muted-foreground">{[r.contact.title, r.contact.organisation].filter(Boolean).join(' · ')}</span>
              {/if}
              {#if r.contact.channels.length > 0}
                <span class="truncate text-xs text-muted-foreground"
                  >{r.contact.channels.map((c) => `${CHANNEL_LABELS[c.type]}: ${c.value}`).join(' · ')}</span
                >
              {/if}
              {#if r.contact.tags.length > 0}<span class="text-xs text-muted-foreground">Tags: {r.contact.tags.join(', ')}</span>{/if}
              {#if r.contact.whyRelevant}<span class="line-clamp-2 text-xs text-muted-foreground">Why they matter: {r.contact.whyRelevant}</span>{/if}
            </label>
          </li>
        {/if}
      {/each}
    </ul>
  {/if}

  {#if others.length > 0}
    <ul class="grid gap-1.5 text-sm" aria-label="Not imported" data-testid="import-not-imported">
      {#each others as r (r.index)}
        <li data-testid={`import-${r.status}`}>
          {#if r.status === 'duplicate'}
            <span class="font-medium">{r.contact.name}</span>
            <span class="text-muted-foreground">
              — {r.email} is already
              {#if r.existing}
                in your contacts as <a class="underline" href={resolve(`/m/email/people/${r.existing.id}`)}>{r.existing.name}</a>. Not imported; that contact stays as it is.
              {:else}
                in an earlier row of this file. Not imported twice.
              {/if}
            </span>
          {:else if r.status === 'invalid'}
            <span class="font-medium">Row {r.index + 1}{r.name ? ` (${r.name})` : ''}</span>
            <span class="text-destructive">— {r.error}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  <form method="POST" {action} use:enhance class="grid gap-3" data-testid="import-confirm-form">
    <input type="hidden" name="candidates" value={JSON.stringify(chosen.map((r) => r.contact))} data-testid="import-chosen" />
    <label class="flex items-center gap-2 text-sm">
      <input type="checkbox" name="shared" bind:checked={shared} />
      Share them with the company
    </label>
    <p class="text-xs text-muted-foreground">
      {shared ? 'Everyone in the company will see and update them.' : 'Private: only you, the company owner and admins will see them.'}
    </p>
    {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
    <div class="flex flex-wrap gap-2">
      <Button type="submit" disabled={chosen.length === 0} data-testid="import-confirm"
        >Import {chosen.length} {chosen.length === 1 ? 'contact' : 'contacts'}</Button
      >
      <Button variant="ghost" href={resolve('/m/email/people/import')}>Start over</Button>
    </div>
  </form>
</div>
