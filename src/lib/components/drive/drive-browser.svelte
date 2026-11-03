<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- every href is built with resolve() */
  import FileIcon from '@lucide/svelte/icons/file'
  import FileTextIcon from '@lucide/svelte/icons/file-text'
  import FolderIcon from '@lucide/svelte/icons/folder'
  import ImageIcon from '@lucide/svelte/icons/image'
  import SheetIcon from '@lucide/svelte/icons/sheet'
  import UploadIcon from '@lucide/svelte/icons/upload'
  import { goto, invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { driveApi, formatSize, type DriveItem } from '$lib/drive/api'
  import DriveItemActions from './drive-item-actions.svelte'
  import NameDialog from './name-dialog.svelte'

  /**
   * One Drive listing: toolbar (New ▸ Folder / Document / Table, Upload,
   * search), the folder path, drag-and-drop upload onto the list, and the
   * rows with their actions. The server checks every act again; the buttons
   * only hide what the person can't do anyway.
   */
  let {
    folderId,
    path = [],
    items,
    canEdit,
    query = '',
    results = null,
    emptyText = 'Nothing here yet. Drop files here or use New.',
    trashView = false,
    showToolbar = true,
    root = { label: 'My drive', href: '/drive' },
  }: {
    folderId: string | null
    path?: Array<{ id: string; name: string }>
    items: DriveItem[]
    canEdit: boolean
    query?: string
    results?: DriveItem[] | null
    emptyText?: string
    trashView?: boolean
    showToolbar?: boolean
    /** Where the path starts: "My drive", "Shared with me" or "Messages" (from the server). */
    root?: { label: string; href: string }
  } = $props()

  let error = $state<string | null>(null)
  let notice = $state<string | null>(null)
  let busy = $state(false)
  let dragging = $state(false)
  let newMenuOpen = $state(false)
  let nameDialog = $state<{ title: string; label: string; initial: string; submit: (name: string) => Promise<void> } | null>(null)
  let fileInput = $state<HTMLInputElement | null>(null)
  let search = $state(query)

  const shown = $derived(results ?? items)

  const folderHref = (id: string) => resolve(`/drive/folder/${id}`)
  const fileHref = (id: string) => resolve(`/drive/file/${id}`)
  const here = () => (folderId ? folderHref(folderId) : resolve('/drive'))

  async function run(act: () => Promise<unknown>, ok?: string) {
    error = null
    notice = null
    busy = true
    try {
      await act()
      if (ok) notice = ok
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  async function uploadFiles(files: File[]) {
    if (files.length === 0) return
    error = null
    notice = null
    busy = true
    try {
      const out = await driveApi.upload(folderId, files)
      if (out.errors.length > 0) error = out.errors.join(' ')
      if (out.uploaded.length > 0) notice = `Uploaded ${out.uploaded.length} file${out.uploaded.length === 1 ? '' : 's'}.`
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault()
    dragging = false
    if (!canEdit || trashView) return
    void uploadFiles([...(event.dataTransfer?.files ?? [])])
  }
  function onDragOver(event: DragEvent) {
    if (!canEdit || trashView) return
    event.preventDefault()
    dragging = true
  }

  function newFolder() {
    newMenuOpen = false
    nameDialog = {
      title: 'New folder',
      label: 'Folder name',
      initial: '',
      submit: (name) => run(() => driveApi.createFolder(folderId, name), `Created folder “${name}”.`),
    }
  }
  function newDocument(kind: 'md' | 'csv') {
    newMenuOpen = false
    nameDialog = {
      title: kind === 'md' ? 'New document' : 'New table',
      label: kind === 'md' ? 'Document name (.md)' : 'Table name (.csv)',
      initial: kind === 'md' ? 'Untitled document' : 'Untitled table',
      submit: async (name) => {
        error = null
        try {
          const file = await driveApi.createDocument(folderId, kind, name)
          await goto(fileHref(file.id))
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
      },
    }
  }

  function submitSearch(event: SubmitEvent) {
    event.preventDefault()
    const q = search.trim()
    void goto(q ? `${here()}?q=${encodeURIComponent(q)}` : here(), { keepFocus: true })
  }

  function iconFor(item: DriveItem) {
    if (item.type === 'folder') return FolderIcon
    const n = item.name.toLowerCase()
    if (n.endsWith('.md') || n.endsWith('.txt')) return FileTextIcon
    if (n.endsWith('.csv')) return SheetIcon
    if (item.mime?.startsWith('image/')) return ImageIcon
    return FileIcon
  }
  const fmtDate = (d: string | Date) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
</script>

<section class="mt-6 flex flex-col gap-4" data-testid="drive-browser">
  {#if showToolbar}
    <div class="flex flex-wrap items-center gap-2">
      {#if canEdit}
        <div class="relative">
          <Button onclick={() => (newMenuOpen = !newMenuOpen)} aria-expanded={newMenuOpen} data-testid="drive-new">New</Button>
          {#if newMenuOpen}
            <div class="absolute left-0 z-20 mt-1 flex w-48 flex-col rounded-md border bg-popover p-1 text-sm shadow-md" role="menu" data-testid="drive-new-menu">
              <button class="rounded px-3 py-2 text-left hover:bg-muted" role="menuitem" onclick={newFolder} data-testid="drive-new-folder">Folder</button>
              <button class="rounded px-3 py-2 text-left hover:bg-muted" role="menuitem" onclick={() => newDocument('md')} data-testid="drive-new-document">Document (.md)</button>
              <button class="rounded px-3 py-2 text-left hover:bg-muted" role="menuitem" onclick={() => newDocument('csv')} data-testid="drive-new-table">Table (.csv)</button>
            </div>
          {/if}
        </div>
        <Button variant="outline" onclick={() => fileInput?.click()} disabled={busy} data-testid="drive-upload">
          <UploadIcon class="size-4" /> Upload
        </Button>
        <input
          bind:this={fileInput}
          type="file"
          multiple
          class="hidden"
          data-testid="drive-upload-input"
          onchange={(e) => {
            const input = e.currentTarget as HTMLInputElement
            void uploadFiles([...(input.files ?? [])])
            input.value = ''
          }}
        />
      {/if}
      <form class="ml-auto flex items-center gap-2" onsubmit={submitSearch} role="search">
        <Input class="h-9 w-56" placeholder="Search by name" bind:value={search} aria-label="Search Drive by name" data-testid="drive-search" />
      </form>
    </div>
  {/if}

  {#if !trashView}
    <nav aria-label="Folder path" class="flex flex-wrap items-center gap-1 text-sm" data-testid="drive-path">
      <a href={root.href} class="text-muted-foreground hover:text-foreground" data-testid="drive-path-root">{root.label}</a>
      {#each path as crumb (crumb.id)}
        <span class="text-muted-foreground">/</span>
        <a href={folderHref(crumb.id)} class="hover:text-foreground {crumb.id === folderId ? 'font-medium text-foreground' : 'text-muted-foreground'}">{crumb.name}</a>
      {/each}
    </nav>
  {/if}

  {#if error}
    <p class="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="drive-error">{error}</p>
  {/if}
  {#if notice}
    <p class="rounded-md border px-3 py-2 text-sm text-muted-foreground" role="status" data-testid="drive-notice">{notice}</p>
  {/if}
  {#if results}
    <p class="text-sm text-muted-foreground" data-testid="drive-search-summary">
      {results.length} result{results.length === 1 ? '' : 's'} for “{query}” ·
      <a href={here()} class="underline-offset-2 hover:underline">clear</a>
    </p>
  {/if}

  <div
    class="rounded-lg border {dragging ? 'border-primary bg-primary/5' : ''}"
    ondragover={onDragOver}
    ondragleave={() => (dragging = false)}
    ondrop={onDrop}
    role="region"
    aria-label="Files"
    data-testid="drive-dropzone"
  >
    {#if shown.length === 0}
      <p class="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="drive-empty">{results ? 'No file or folder by that name.' : emptyText}</p>
    {:else}
      <table class="w-full text-sm">
        <thead class="text-left text-xs text-muted-foreground">
          <tr class="border-b">
            <th class="px-4 py-2 font-medium">Name</th>
            <th class="hidden px-4 py-2 font-medium sm:table-cell">{trashView ? 'Trashed' : 'Modified'}</th>
            <th class="hidden px-4 py-2 font-medium sm:table-cell">Size</th>
            <th class="px-4 py-2"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {#each shown as item (item.type + item.id)}
            {@const Icon = iconFor(item)}
            <tr class="border-b last:border-0 hover:bg-muted/40" data-testid="drive-row" data-name={item.name} data-type={item.type}>
              <td class="px-4 py-2">
                <span class="flex min-w-0 items-center gap-2">
                  <Icon class="size-4 shrink-0 text-muted-foreground" />
                  {#if trashView}
                    <span class="truncate">{item.name}</span>
                  {:else}
                    <a class="truncate hover:underline" href={item.type === 'folder' ? folderHref(item.id) : fileHref(item.id)} data-testid="drive-open">{item.name}</a>
                  {/if}
                </span>
              </td>
              <td class="hidden px-4 py-2 text-muted-foreground sm:table-cell">{fmtDate(trashView && item.trashedAt ? item.trashedAt : item.updatedAt)}</td>
              <td class="hidden px-4 py-2 text-muted-foreground sm:table-cell">{item.type === 'file' ? formatSize(item.size) : '—'}</td>
              <td class="px-4 py-2 text-right">
                <DriveItemActions {item} {trashView} {run} />
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
  {#if canEdit && !trashView}
    <p class="text-xs text-muted-foreground">Drag files onto the list to upload them here.</p>
  {/if}
</section>

{#if nameDialog}
  <NameDialog {...nameDialog} onclose={() => (nameDialog = null)} />
{/if}
