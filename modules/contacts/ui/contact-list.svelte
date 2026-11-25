<script lang="ts">
  import type { ChangeSharing } from '../client'
  import type { ContactDto, ShareChoices, SharingResult } from '../types'
  import { resolve } from '$app/paths'
  import { relativeDays, visibilityLabel } from '../types'
  import ChannelLinks from './channel-links.svelte'
  import SharingBar from './sharing-bar.svelte'

  /**
   * The people, by name: organisation and role, tags, how to reach them, when
   * you were last in touch, and who can see each one (private, the whole team,
   * or the people and groups it is shared with).
   *
   * With `sharing` (Contribute 9d28020a): a checkbox on every row, "Select
   * all" for the contacts shown (the current tag and search), and an action
   * bar for the selected ones — Share with… / Make private in one call.
   */
  let {
    contacts,
    today,
    empty,
    sharing = null,
  }: {
    contacts: readonly ContactDto[]
    today: string
    empty: string
    sharing?: {
      choices: ShareChoices
      change: ChangeSharing
      onchanged: () => void | Promise<void>
    } | null
  } = $props()

  let picked = $state<string[]>([])
  let report = $state<string | null>(null)

  // Only what is shown counts: a selection made before the filter changed doesn't reach hidden contacts.
  const selected = $derived(picked.filter((id) => contacts.some((c) => c.id === id)))
  const allSelected = $derived(contacts.length > 0 && selected.length === contacts.length)
  const someSelected = $derived(selected.length > 0 && !allSelected)

  const daysSince = (day: string) => Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)

  function toggle(id: string, on: boolean): void {
    picked = on ? [...picked.filter((x) => x !== id), id] : picked.filter((x) => x !== id)
  }

  function toggleAll(on: boolean): void {
    picked = on ? contacts.map((c) => c.id) : []
  }

  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

  async function done(result: SharingResult): Promise<void> {
    const notYours = result.skipped.filter((s) => s.reason === 'not_yours')
    const gone = result.skipped.length - notYours.length
    const parts = [`Changed ${plural(result.changed.length, 'contact', 'contacts')}.`]
    if (notYours.length > 0) {
      parts.push(
        `Skipped ${plural(notYours.length, 'contact that isn’t yours', 'contacts that aren’t yours')}: ${notYours.map((s) => s.name).join(', ')} — only the person who added them, the owner and admins can change who sees them.`,
      )
    }
    if (gone > 0) parts.push(`${plural(gone, 'contact was', 'contacts were')} no longer there.`)
    report = parts.join(' ')
    // What wasn't changed stays selected, so nothing is silently dropped.
    picked = picked.filter((id) => !result.changed.includes(id))
    await sharing?.onchanged()
  }
</script>

{#if contacts.length === 0}
  <p class="text-sm text-muted-foreground" data-testid="contacts-empty">{empty}</p>
{:else}
  {#if sharing}
    <div class="flex flex-wrap items-center justify-between gap-2 px-1">
      <label class="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={allSelected}
          indeterminate={someSelected}
          onchange={(e) => toggleAll((e.currentTarget as HTMLInputElement).checked)}
          data-testid="contacts-select-all"
        />
        Select all {contacts.length}
      </label>
      {#if report}<p class="text-xs text-muted-foreground" role="status" data-testid="contacts-sharing-report">
          {report}
        </p>{/if}
    </div>
  {/if}
  <ul class="divide-y divide-border rounded-lg border border-border" data-testid="contacts">
    {#each contacts as c (c.id)}
      <li class="flex gap-3 px-4 py-3 sm:px-5" data-testid="contact-row">
        {#if sharing}
          <input
            type="checkbox"
            class="mt-1 shrink-0"
            aria-label={`Select ${c.name}`}
            checked={selected.includes(c.id)}
            onchange={(e) => toggle(c.id, (e.currentTarget as HTMLInputElement).checked)}
            data-testid="contact-select"
          />
        {/if}
        <div class="grid min-w-0 flex-1 gap-1.5">
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div class="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <a class="truncate text-sm font-medium hover:underline" href={resolve(`/m/email/people/${c.id}`)}>{c.name}</a>
              {#if c.organisation || c.title}
                <span class="text-xs text-muted-foreground">{[c.title, c.organisation].filter(Boolean).join(' · ')}</span>
              {/if}
            </div>
            <span class="text-xs text-muted-foreground" data-testid="contact-visibility">{visibilityLabel(c)}</span>
          </div>
          {#if c.tags.length > 0}
            <ul class="flex flex-wrap gap-1.5" aria-label="Tags">
              {#each c.tags as tag (tag)}
                <li class="rounded-full border border-border px-2 py-0.5 text-xs">{tag}</li>
              {/each}
            </ul>
          {/if}
          <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <ChannelLinks channels={c.channels} limit={3} />
            {#if c.lastContactedOn}
              <span class="text-xs text-muted-foreground">Last in touch {relativeDays(daysSince(c.lastContactedOn))}</span>
            {/if}
          </div>
        </div>
      </li>
    {/each}
  </ul>
  {#if sharing && selected.length > 0}
    <SharingBar ids={selected} choices={sharing.choices} change={sharing.change} ondone={done} onclear={() => (picked = [])} />
  {/if}
{/if}
