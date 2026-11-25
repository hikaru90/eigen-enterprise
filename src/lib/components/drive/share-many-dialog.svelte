<script lang="ts">
  import { onMount } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import {
    driveApi,
    type AccessLevel,
    type GrantEntry,
    type GrantSubject,
    type ShareTargets,
  } from '$lib/drive/api'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Share several selected items at once (drive.share_many): pick people,
   * groups or everyone, each at an access level; every selected item gets
   * them. It only adds access — nobody who has access loses it — so there is
   * no list of each item's current grants to edit here (the row's Share does that).
   */
  let {
    count,
    submit,
    onclose,
  }: { count: number; submit: (grants: GrantEntry[]) => Promise<void>; onclose: () => void } =
    $props()

  const LEVELS: Array<{ id: AccessLevel; label: () => string }> = [
    { id: 'view', label: m.drive_share_level_view },
    { id: 'edit', label: m.drive_share_level_edit },
    { id: 'manage', label: m.drive_share_level_manage },
  ]

  let open = $state(true)
  let targets = $state<ShareTargets>({ people: [], groups: [] })
  let grants = $state<GrantEntry[]>([])
  let error = $state<ShownError | null>(null)
  let loading = $state(true)
  let saving = $state(false)

  const keyOf = (s: GrantSubject) =>
    s.kind === 'user' ? `user:${s.userId}` : s.kind === 'group' ? `group:${s.groupId}` : 'company'
  function labelOf(s: GrantSubject): string {
    if (s.kind === 'company') return m.drive_share_many_everyone()
    if (s.kind === 'group')
      return m.drive_share_many_group({
        name: targets.groups.find((g) => g.id === s.groupId)?.name ?? s.groupId,
      })
    const p = targets.people.find((x) => x.id === s.userId)
    return p ? `${p.name || p.email} (${p.email})` : s.userId
  }
  const taken = $derived(new Set(grants.map((g) => keyOf(g.subject))))
  const candidates = $derived(
    [
      { kind: 'company' } as GrantSubject,
      ...targets.groups.map((g): GrantSubject => ({ kind: 'group', groupId: g.id })),
      ...targets.people.map((p): GrantSubject => ({ kind: 'user', userId: p.id })),
    ].filter((s) => !taken.has(keyOf(s))),
  )

  onMount(async () => {
    try {
      targets = await driveApi.shareTargets()
    } catch (err) {
      error = driveShownError(err)
    } finally {
      loading = false
    }
  })

  function add(select: HTMLSelectElement) {
    const subject = candidates.find((c) => keyOf(c) === select.value)
    select.value = ''
    if (subject) grants = [...grants, { subject, level: 'view' }]
  }

  function close() {
    open = false
    onclose()
  }

  async function share() {
    error = null
    saving = true
    try {
      await submit(grants)
      close()
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
  <Dialog.Content class="max-w-lg grid-cols-[minmax(0,1fr)]" data-testid="drive-share-many-dialog">
    <Dialog.Header>
      <Dialog.Title>{m.drive_share_many_title({ count })}</Dialog.Title>
      <Dialog.Description>{m.drive_share_many_description()}</Dialog.Description>
    </Dialog.Header>

    {#if grants.length > 0}
      <ul class="flex flex-col divide-y rounded-md border text-sm" data-testid="drive-share-many-list">
        {#each grants as g, i (keyOf(g.subject))}
          <li class="flex items-center gap-2 px-3 py-2" data-testid="drive-share-many-row">
            <span class="min-w-0 flex-1 truncate">{labelOf(g.subject)}</span>
            <select
              class="h-8 rounded-md border bg-background px-2"
              bind:value={grants[i]!.level}
              aria-label={m.drive_share_many_level()}
              data-testid="drive-share-many-level"
            >
              {#each LEVELS as l (l.id)}<option value={l.id}>{l.label()}</option>{/each}
            </select>
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground"
              onclick={() => (grants = grants.filter((_, j) => j !== i))}
              aria-label={m.drive_share_many_remove({ name: labelOf(g.subject) })}>×</button
            >
          </li>
        {/each}
      </ul>
    {/if}

    <select
      class="h-9 rounded-md border bg-background px-2 text-sm"
      aria-label={m.drive_share_many_add()}
      disabled={loading}
      data-testid="drive-share-many-pick"
      onchange={(e) => add(e.currentTarget)}
    >
      <option value="">{m.drive_share_many_add()}</option>
      {#each candidates as c (keyOf(c))}<option value={keyOf(c)}>{labelOf(c)}</option>{/each}
    </select>

    {#if error}<ErrorNotice
        testid="drive-share-many-error"
        error={error.error}
        agent={error.agent}
        attempted="Sharing several Drive items at once"
      />{/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={close}>{m.drive_share_many_cancel()}</Button>
      <Button
        onclick={share}
        disabled={saving || loading || grants.length === 0}
        data-testid="drive-share-many-submit">{m.drive_share_many_submit()}</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
