<script lang="ts">
  import FileTextIcon from '@lucide/svelte/icons/file-text'
  import FolderIcon from '@lucide/svelte/icons/folder'
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { driveApi, type DriveItem } from '$lib/drive/api'
  import { driveItemKind } from '$lib/drive/display'

  /**
   * Choose a PDF from the Drive (Organise → Insert from a PDF): walk the
   * folders from My drive and pick a file. `exclude` is the open file.
   */
  let {
    exclude,
    onpick,
    onclose,
  }: { exclude: string; onpick: (file: DriveItem) => void; onclose: () => void } = $props()

  let open = $state(true)
  let path = $state<Array<{ id: string; name: string }>>([])
  let folders = $state<DriveItem[]>([])
  let pdfs = $state<DriveItem[]>([])
  let loading = $state(true)
  let error = $state<string | null>(null)

  async function go(id: string | null) {
    error = null
    loading = true
    try {
      const out = await driveApi.listFolder(id)
      path = out.path
      folders = out.items.filter((i) => i.type === 'folder')
      pdfs = out.items.filter((i) => driveItemKind(i) === 'pdf' && i.id !== exclude)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      loading = false
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
  <Dialog.Content class="max-w-md grid-cols-[minmax(0,1fr)]" data-testid="pdf-picker">
    <Dialog.Header>
      <Dialog.Title>Insert pages from a PDF</Dialog.Title>
      <Dialog.Description>Choose the PDF whose pages to add.</Dialog.Description>
    </Dialog.Header>
    <nav class="flex flex-wrap gap-1 text-sm" aria-label="Folder path">
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground"
        onclick={() => go(null)}>My drive</button
      >
      {#each path as c (c.id)}
        <span class="text-muted-foreground">/</span>
        <button type="button" class="hover:text-foreground" onclick={() => go(c.id)}
          >{c.name}</button
        >
      {/each}
    </nav>
    <ul class="max-h-64 overflow-y-auto rounded-md border text-sm" aria-busy={loading}>
      {#each folders as f (f.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
            onclick={() => go(f.id)}
            data-testid="pdf-picker-folder"
          >
            <FolderIcon class="size-4 text-muted-foreground" />{f.name}
          </button>
        </li>
      {/each}
      {#each pdfs as f (f.id)}
        <li>
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
            onclick={() => {
              onpick(f)
              close()
            }}
            data-testid="pdf-picker-file"
          >
            <FileTextIcon class="size-4 text-muted-foreground" />{f.name}
          </button>
        </li>
      {/each}
      {#if !loading && folders.length === 0 && pdfs.length === 0}
        <li class="px-3 py-4 text-muted-foreground">No PDFs or folders here.</li>
      {/if}
    </ul>
    {#if error}<p class="text-sm text-destructive" role="alert">{error}</p>{/if}
    <Dialog.Footer>
      <Button variant="outline" onclick={close}>Cancel</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
