<script lang="ts">
  import FolderIcon from '@lucide/svelte/icons/folder'
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { driveApi, type DriveItem } from '$lib/drive/api'

  /** Pick a target folder: walk My drive's folders, move here. */
  let { item, submit, onclose }: { item: DriveItem; submit: (folderId: string | null) => Promise<void>; onclose: () => void } = $props()

  let open = $state(true)
  let at = $state<string | null>(null)
  let path = $state<Array<{ id: string; name: string }>>([])
  let folders = $state<DriveItem[]>([])
  let canEdit = $state(true)
  let error = $state<string | null>(null)

  async function go(id: string | null) {
    error = null
    try {
      const out = await driveApi.listFolder(id)
      at = id
      path = out.path
      canEdit = out.canEdit
      folders = out.items.filter((i) => i.type === 'folder' && !(item.type === 'folder' && i.id === item.id))
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
  }
  onMount(() => {
    void go(null)
  })

  function close() {
    open = false
    onclose()
  }
</script>

<Dialog.Root
  bind:open
  onOpenChange={(o) => {
    if (!o) onclose()
  }}
>
  <Dialog.Content class="max-w-md grid-cols-[minmax(0,1fr)]" data-testid="drive-move-dialog">
    <Dialog.Header>
      <Dialog.Title>Move “{item.name}”</Dialog.Title>
      <Dialog.Description>Choose the folder to move it into.</Dialog.Description>
    </Dialog.Header>
    <nav class="flex flex-wrap gap-1 text-sm" aria-label="Target folder path">
      <button class="text-muted-foreground hover:text-foreground" onclick={() => go(null)}>My drive</button>
      {#each path as c (c.id)}
        <span class="text-muted-foreground">/</span>
        <button class="hover:text-foreground" onclick={() => go(c.id)}>{c.name}</button>
      {/each}
    </nav>
    <ul class="max-h-64 overflow-y-auto rounded-md border text-sm">
      {#each folders as f (f.id)}
        <li>
          <button class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted" onclick={() => go(f.id)} data-testid="drive-move-folder">
            <FolderIcon class="size-4 text-muted-foreground" />{f.name}
          </button>
        </li>
      {:else}
        <li class="px-3 py-4 text-muted-foreground">No folders here.</li>
      {/each}
    </ul>
    {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={close}>Cancel</Button>
      <Button
        disabled={!canEdit}
        data-testid="drive-move-here"
        onclick={async () => {
          await submit(at)
          close()
        }}>Move here</Button
      >
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
