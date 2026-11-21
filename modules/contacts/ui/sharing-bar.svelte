<script lang="ts">
  import type { ChangeSharing, SharingRequest } from '../client'
  import type { ShareChoices, SharingResult } from '../types'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import type { ShownError } from '$lib/errors/agent-report'
  import { ContactsRequestError } from '../client'

  /**
   * The action bar for the selected contacts (Contribute 9d28020a): how many
   * are selected, "Share with…" (the whole team — everyone, including people
   * who join later — and/or people and groups), "Make private", and clearing
   * the selection. One server call for all of them; the answer says how many
   * changed and which were left alone because they aren't yours.
   */
  let {
    ids,
    choices,
    change,
    ondone,
    onclear,
  }: {
    ids: readonly string[]
    choices: ShareChoices
    change: ChangeSharing
    /** After a change: what happened (the page reloads its data). */
    ondone: (result: SharingResult) => void
    onclear: () => void
  } = $props()

  let picking = $state(false)
  let team = $state(false)
  let userIds = $state<string[]>([])
  let groupIds = $state<string[]>([])
  let busy = $state(false)
  let error = $state<ShownError | null>(null)

  const nothingPicked = $derived(!team && userIds.length === 0 && groupIds.length === 0)
  const count = $derived(ids.length)

  function toggle(list: string[], id: string, on: boolean): string[] {
    return on ? [...list, id] : list.filter((x) => x !== id)
  }

  function openPicker(): void {
    picking = !picking
    error = null
  }

  async function run(request: SharingRequest): Promise<void> {
    busy = true
    error = null
    try {
      const result = await change(request)
      picking = false
      team = false
      userIds = []
      groupIds = []
      ondone(result)
    } catch (err) {
      error = {
        error: err instanceof Error ? err.message : String(err),
        agent: err instanceof ContactsRequestError ? err.agent : null,
      }
    } finally {
      busy = false
    }
  }

  const share = () =>
    run({
      action: 'share',
      ids: [...ids],
      targets: { team, userIds: [...userIds], groupIds: [...groupIds] },
    })
  const makePrivate = () => run({ action: 'private', ids: [...ids] })
</script>

<div
  class="sticky bottom-4 z-10 grid gap-3 rounded-lg border border-border bg-background px-4 py-3 shadow-sm"
  role="region"
  aria-label="Selected contacts"
  data-testid="contacts-action-bar"
>
  {#if picking}
    <div class="grid gap-3" data-testid="contacts-share-picker">
      <label class="flex items-start gap-2 text-sm">
        <input type="checkbox" class="mt-1" bind:checked={team} data-testid="share-team" />
        <span
          >Whole team <span class="block text-xs text-muted-foreground"
            >Everyone in the company, including people who join later.</span
          ></span
        >
      </label>
      {#if choices.groups.length > 0}
        <fieldset class="grid gap-1.5">
          <legend class="text-xs font-medium text-muted-foreground">Groups</legend>
          <div class="flex flex-wrap gap-x-4 gap-y-1.5">
            {#each choices.groups as g (g.id)}
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={groupIds.includes(g.id)}
                  onchange={(e) =>
                    (groupIds = toggle(
                      groupIds,
                      g.id,
                      (e.currentTarget as HTMLInputElement).checked,
                    ))}
                />
                {g.name}
              </label>
            {/each}
          </div>
        </fieldset>
      {/if}
      <fieldset class="grid gap-1.5">
        <legend class="text-xs font-medium text-muted-foreground">People</legend>
        <div class="flex flex-wrap gap-x-4 gap-y-1.5">
          {#each choices.people as p (p.id)}
            <label class="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={userIds.includes(p.id)}
                onchange={(e) =>
                  (userIds = toggle(userIds, p.id, (e.currentTarget as HTMLInputElement).checked))}
              />
              {p.name}
            </label>
          {/each}
        </div>
      </fieldset>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || nothingPicked}
          onclick={share}
          data-testid="share-confirm">Share {count} {count === 1 ? 'contact' : 'contacts'}</Button
        >
        <Button size="sm" variant="ghost" onclick={() => (picking = false)}>Cancel</Button>
      </div>
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-between gap-2">
    <span class="text-sm font-medium" data-testid="contacts-selected-count">{count} selected</span>
    <div class="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant={picking ? 'secondary' : 'outline'}
        disabled={busy}
        onclick={openPicker}
        aria-expanded={picking}
        data-testid="contacts-share-with">Share with…</Button
      >
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onclick={makePrivate}
        data-testid="contacts-make-private">Make private</Button
      >
      <Button size="sm" variant="ghost" disabled={busy} onclick={onclear}>Clear</Button>
    </div>
  </div>
  {#if error}<ErrorNotice {...error} attempted="Changing who sees the chosen contacts" />{/if}
</div>
