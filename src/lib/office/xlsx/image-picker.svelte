<script lang="ts">
  import FolderIcon from '@lucide/svelte/icons/folder'
  import ImageIcon from '@lucide/svelte/icons/image'
  import { onMount } from 'svelte'
  import ErrorNotice from '$lib/components/error-notice.svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { driveApi, type DriveItem } from '$lib/drive/api'
  import { driveShownError } from '$lib/drive/shown-error'
  import type { ShownError } from '$lib/errors/agent-report'
  import { m } from '$lib/paraglide/messages.js'

  /**
   * Choose a PNG, JPEG, GIF or BMP image from Drive folders to insert onto
   * the active worksheet.
   */
  let {
    initialFolderId = null,
    onpick,
    onclose,
  }: {
    initialFolderId?: string | null
    onpick: (file: DriveItem) => void
    onclose: () => void
  } = $props()

  const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/bmp'])
  const IMAGE_EXT = /\.(png|jpe?g|gif|bmp)$/i

  function isSupportedImage(item: DriveItem): boolean {
    if (item.type !== 'file') return false
    if (item.mime && IMAGE_MIME.has(item.mime.toLowerCase())) return true
    return IMAGE_EXT.test(item.name)
  }

  let open = $state(true)
  let path = $state<Array<{ id: string; name: string }>>([])
  let folders = $state<DriveItem[]>([])
  let images = $state<DriveItem[]>([])
  let loading = $state(true)
  let error = $state<ShownError | null>(null)

  async function go(id: string | null) {
    error = null
    loading = true
    try {
      const out = await driveApi.listFolder(id)
      path = out.path
      folders = out.items.filter((i) => i.type === 'folder')
      images = out.items.filter(isSupportedImage)
    } catch (err) {
      error = driveShownError(err)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void go(initialFolderId)
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
  <Dialog.Content class="max-w-md grid-cols-[minmax(0,1fr)]" data-testid="xlsx-image-picker">
    <Dialog.Header>
      <Dialog.Title>{m.drive_sheet_pick_image_title()}</Dialog.Title>
      <Dialog.Description>{m.drive_sheet_pick_image_desc()}</Dialog.Description>
    </Dialog.Header>
    <nav class="flex flex-wrap gap-1 text-sm" aria-label={m.drive_sheet_my_drive()}>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground"
        onclick={() => go(null)}>{m.drive_sheet_my_drive()}</button
      >
      {#each path as c (c.id)}
        <span class="text-muted-foreground">/</span>
        <button type="button" class="hover:text-foreground" onclick={() => go(c.id)}>{c.name}</button>
      {/each}
    </nav>
    <ul class="max-h-64 overflow-y-auto rounded-md border text-sm" aria-busy={loading}>
      {#each folders as f (f.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
            onclick={() => go(f.id)}
            data-testid="xlsx-image-picker-folder"
          >
            <FolderIcon class="size-4 text-muted-foreground" aria-hidden="true" />{f.name}
          </button>
        </li>
      {/each}
      {#each images as f (f.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
            onclick={() => {
              onpick(f)
              close()
            }}
            data-testid="xlsx-image-picker-file"
          >
            <ImageIcon class="size-4 text-muted-foreground" aria-hidden="true" />{f.name}
          </button>
        </li>
      {/each}
      {#if !loading && folders.length === 0 && images.length === 0}
        <li class="px-3 py-6 text-center text-muted-foreground">
          {m.drive_sheet_pick_image_empty()}
        </li>
      {/if}
    </ul>
    {#if error}<ErrorNotice error={error.error} agent={error.agent} />{/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={close}>{m.drive_sheet_cancel()}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
