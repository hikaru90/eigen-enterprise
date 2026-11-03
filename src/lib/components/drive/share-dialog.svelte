<script lang="ts">
  import { onMount } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { driveApi, type AccessLevel, type DriveItem, type GrantEntry, type GrantSubject, type ShareTargets } from '$lib/drive/api'

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
  let pick = $state('')
  let pickLevel = $state<AccessLevel>('view')
  let error = $state<string | null>(null)
  let loading = $state(true)
  let saving = $state(false)

  const keyOf = (s: GrantSubject) => (s.kind === 'user' ? `user:${s.userId}` : s.kind === 'group' ? `group:${s.groupId}` : 'company')
  function subjectOf(key: string): GrantSubject {
    if (key === 'company') return { kind: 'company' }
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)]
    return kind === 'user' ? { kind: 'user', userId: id } : { kind: 'group', groupId: id }
  }
  function labelOf(s: GrantSubject): string {
    if (s.kind === 'company') return 'Everyone in the company'
    if (s.kind === 'group') return `Group: ${targets.groups.find((g) => g.id === s.groupId)?.name ?? 'unknown group'}`
    const p = targets.people.find((x) => x.id === s.userId)
    return p ? `${p.name || p.email} (${p.email})` : 'Unknown person'
  }
  const taken = $derived(new Set(grants.map((g) => keyOf(g.subject))))

  onMount(async () => {
    try {
      const [g, t] = await Promise.all([driveApi.grants(item), driveApi.shareTargets()])
      grants = g.grants.map((x) => ({ subject: x.subject, level: x.level }))
      targets = t
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
    }
  })

  function add() {
    if (!pick || taken.has(pick)) return
    grants = [...grants, { subject: subjectOf(pick), level: pickLevel }]
    pick = ''
  }

  async function save() {
    error = null
    saving = true
    try {
      await driveApi.setGrants(item, grants)
      await invalidateAll()
      open = false
      onclose()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
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
        {item.type === 'folder' ? 'Everything inside this folder is shared the same way.' : 'Who can open this file.'} The owner and admins can always manage.
      </Dialog.Description>
    </Dialog.Header>

    {#if loading}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {:else}
      <ul class="flex flex-col divide-y rounded-md border text-sm" data-testid="drive-share-list">
        {#each grants as g, i (keyOf(g.subject))}
          <li class="flex items-center gap-2 px-3 py-2" data-testid="drive-share-row">
            <span class="min-w-0 flex-1 truncate">{labelOf(g.subject)}</span>
            <select class="h-8 rounded-md border bg-background px-2" bind:value={grants[i]!.level} aria-label={`Access for ${labelOf(g.subject)}`} data-testid="drive-share-level">
              {#each LEVELS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
            </select>
            <button class="text-muted-foreground hover:text-foreground" onclick={() => (grants = grants.filter((_, j) => j !== i))} aria-label={`Remove ${labelOf(g.subject)}`}>Remove</button>
          </li>
        {:else}
          <li class="px-3 py-3 text-muted-foreground">Only you{item.type === 'folder' ? ', people with access to folders above,' : ''} and admins can open it.</li>
        {/each}
      </ul>

      <div class="flex flex-wrap items-center gap-2">
        <select class="h-9 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm" bind:value={pick} aria-label="Share with" data-testid="drive-share-pick">
          <option value="">Add people, a group or everyone…</option>
          {#if !taken.has('company')}<option value="company">Everyone in the company</option>{/if}
          {#each targets.groups as gr (gr.id)}
            {#if !taken.has(`group:${gr.id}`)}<option value={`group:${gr.id}`}>Group: {gr.name}</option>{/if}
          {/each}
          {#each targets.people as p (p.id)}
            {#if !taken.has(`user:${p.id}`)}<option value={`user:${p.id}`}>{p.name || p.email} ({p.email})</option>{/if}
          {/each}
        </select>
        <select class="h-9 rounded-md border bg-background px-2 text-sm" bind:value={pickLevel} aria-label="Access level" data-testid="drive-share-pick-level">
          {#each LEVELS as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
        </select>
        <Button variant="outline" onclick={add} disabled={!pick} data-testid="drive-share-add">Add</Button>
      </div>
    {/if}

    {#if error}<p class="text-sm text-destructive" role="alert" data-testid="drive-share-error">{error}</p>{/if}
    <Dialog.Footer>
      <Button
        variant="outline"
        onclick={() => {
          open = false
          onclose()
        }}>Cancel</Button
      >
      <Button onclick={save} disabled={saving || loading} data-testid="drive-share-save">Save</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
