<script lang="ts">
  import { onMount } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import {
    driveApi,
    type AccessLevel,
    type DriveItem,
    type GrantEntry,
    type GrantSubject,
    type ShareTargets,
  } from '$lib/drive/api'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'

  /**
   * Share a folder or file with people, groups or everyone in the company, at
   * view / edit / manage. A folder's sharing reaches everything inside it.
   */
  let { item, onclose }: { item: DriveItem; onclose: () => void } = $props()

  const LEVELS: Array<{ id: AccessLevel; label: string }> = [
    { id: 'view', label: 'Can view' },
    { id: 'edit', label: 'Can edit' },
    { id: 'manage', label: 'Can manage' },
  ]

  let open = $state(true)
  let grants = $state<GrantEntry[]>([])
  let targets = $state<ShareTargets>({ people: [], groups: [] })
  /** What is typed in the search; picking a match clears it (so anything left here is not picked yet). */
  let query = $state('')
  /** The access level people get when picked; each row can change its own afterwards. */
  let pickLevel = $state<AccessLevel>('view')
  let error = $state<ShownError | null>(null)
  let announce = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let search = $state<HTMLInputElement | null>(null)

  const keyOf = (s: GrantSubject) =>
    s.kind === 'user' ? `user:${s.userId}` : s.kind === 'group' ? `group:${s.groupId}` : 'company'
  function labelOf(s: GrantSubject): string {
    if (s.kind === 'company') return 'Everyone in the company'
    if (s.kind === 'group')
      return `Group: ${targets.groups.find((g) => g.id === s.groupId)?.name ?? 'unknown group'}`
    const p = targets.people.find((x) => x.id === s.userId)
    return p ? `${p.name || p.email} (${p.email})` : 'Unknown person'
  }
  const taken = $derived(new Set(grants.map((g) => keyOf(g.subject))))
  /** Everyone not in the share yet, narrowed by the search (name, email or group name). */
  const candidates = $derived.by(() => {
    const all: GrantSubject[] = [
      { kind: 'company' },
      ...targets.groups.map((g): GrantSubject => ({ kind: 'group', groupId: g.id })),
      ...targets.people.map((p): GrantSubject => ({ kind: 'user', userId: p.id })),
    ]
    const q = query.trim().toLowerCase()
    return all.filter((s) => !taken.has(keyOf(s)) && (!q || labelOf(s).toLowerCase().includes(q)))
  })
  const levelLabel = (l: AccessLevel) => LEVELS.find((x) => x.id === l)?.label ?? l

  onMount(async () => {
    try {
      const [g, t] = await Promise.all([driveApi.grants(item), driveApi.shareTargets()])
      grants = g.grants.map((x) => ({ subject: x.subject, level: x.level }))
      targets = t
    } catch (err) {
      error = driveShownError(err)
    } finally {
      loading = false
    }
  })

  /** Picking someone puts them in the share right away (Save applies it); there is no separate Add. */
  function pick(subject: GrantSubject) {
    if (taken.has(keyOf(subject))) return
    grants = [...grants, { subject, level: pickLevel }]
    announce = `${labelOf(subject)} added: ${levelLabel(pickLevel)}.`
    query = ''
    error = null
    search?.focus()
  }

  function onSearchKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const first = candidates[0]
    if (query.trim() && first) pick(first)
  }

  async function save() {
    error = null
    // Text left in the search was never picked: say so rather than saving without it.
    if (query.trim()) {
      error = {
        error: `“${query.trim()}” is typed but not picked. Pick them from the list, or clear the search.`,
        agent: null,
      }
      search?.focus()
      return
    }
    saving = true
    try {
      await driveApi.setGrants(item, grants)
      await invalidateAll()
      open = false
      onclose()
    } catch (err) {
      error = driveShownError(err)
    } finally {
      saving = false
    }
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => {
    if (!o) onclose()
  }}
>
  <Dialog.Content class="max-w-lg grid-cols-[minmax(0,1fr)]" data-testid="drive-share-dialog">
    <Dialog.Header>
      <Dialog.Title>Share “{item.name}”</Dialog.Title>
      <Dialog.Description>
        {item.type === 'folder'
          ? 'Everything inside this folder is shared the same way.'
          : 'Who can open this file.'} The owner and admins can always manage.
      </Dialog.Description>
    </Dialog.Header>

    {#if loading}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else}
      <ul class="flex flex-col divide-y rounded-md border text-sm" data-testid="drive-share-list">
        {#each grants as g, i (keyOf(g.subject))}
          <li class="flex items-center gap-2 px-3 py-2" data-testid="drive-share-row">
            <span class="min-w-0 flex-1 truncate">{labelOf(g.subject)}</span>
            <select
              class="h-8 rounded-md border bg-background px-2"
              bind:value={grants[i]!.level}
              aria-label={`Access for ${labelOf(g.subject)}`}
              data-testid="drive-share-level"
            >
              {#each LEVELS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
            </select>
            <button
              class="text-muted-foreground hover:text-foreground"
              onclick={() => (grants = grants.filter((_, j) => j !== i))}
              aria-label={`Remove ${labelOf(g.subject)}`}>Remove</button
            >
          </li>
        {:else}
          <li class="px-3 py-3 text-muted-foreground">
            Only you{item.type === 'folder' ? ', people with access to folders above,' : ''} and admins
            can open it.
          </li>
        {/each}
      </ul>

      <div class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <input
            bind:this={search}
            bind:value={query}
            type="search"
            class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            placeholder="Find people, a group or everyone…"
            aria-label="Share with"
            aria-describedby="drive-share-pick-help"
            onkeydown={onSearchKeydown}
            data-testid="drive-share-pick"
          />
          <select
            class="h-9 rounded-md border bg-background px-2 text-sm"
            bind:value={pickLevel}
            aria-label="Access for people you pick"
            data-testid="drive-share-pick-level"
          >
            {#each LEVELS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
          </select>
        </div>
        <p id="drive-share-pick-help" class="text-xs text-muted-foreground">
          Pick someone to add them; Save applies the changes.
        </p>
        <ul
          class="flex max-h-48 flex-col overflow-y-auto rounded-md border text-sm"
          aria-label="People and groups to share with"
          data-testid="drive-share-candidates"
        >
          {#each candidates as c (keyOf(c))}
            <li>
              <button
                type="button"
                class="w-full truncate px-3 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                aria-label={`Share with ${labelOf(c)}`}
                onclick={() => pick(c)}
                data-testid="drive-share-candidate">{labelOf(c)}</button
              >
            </li>
          {:else}
            <li
              class="px-3 py-2 text-muted-foreground"
              data-testid={query.trim() ? 'drive-share-no-match' : undefined}
            >
              {query.trim()
                ? `No one matches “${query.trim()}”.`
                : 'Everyone is in the share already.'}
            </li>
          {/each}
        </ul>
        <p class="sr-only" aria-live="polite">{announce}</p>
      </div>
    {/if}

    {#if error}<ErrorNotice
        testid="drive-share-error"
        error={error.error}
        agent={error.agent}
        attempted="Sharing a Drive item (reading or saving who has access)"
      />{/if}
    <Dialog.Footer>
      <Button
        variant="outline"
        onclick={() => {
          open = false
          onclose()
        }}>Cancel</Button
      >
      <Button onclick={save} disabled={saving || loading} data-testid="drive-share-save"
        >Save</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
