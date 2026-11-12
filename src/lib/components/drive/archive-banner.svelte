<script lang="ts">
  import ArchiveIcon from '@lucide/svelte/icons/archive'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import { Button } from '$lib/components/ui/button'
  import { driveApi, type Crumb, type DriveItem } from '$lib/drive/api'

  /**
   * On an opened file or folder: says when it is archived (or sits inside an
   * archived folder) and, for those who may edit, offers Unarchive. Nothing
   * shows for an item in everyday use.
   */
  let {
    item,
    archivedIn,
    canEdit,
  }: {
    item: Pick<DriveItem, 'type' | 'id' | 'name' | 'archivedAt'>
    /** The archived folder it sits inside, if any. */
    archivedIn: Crumb | null
    canEdit: boolean
  } = $props()

  let error = $state<string | null>(null)
  let busy = $state(false)
  const when = (d: string | Date) => new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' })

  async function unarchive() {
    error = null
    busy = true
    try {
      await driveApi.unarchive(item)
      await invalidateAll()
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    } finally {
      busy = false
    }
  }
</script>

{#if item.archivedAt || archivedIn}
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-muted/40 px-4 py-2 text-sm sm:px-6"
    role="status"
    data-testid="drive-archive-banner"
  >
    <ArchiveIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    {#if item.archivedAt}
      <span class="min-w-0 flex-1"
        >Archived on {when(item.archivedAt)}. It opens as usual but stays out of the everyday view.</span
      >
      {#if canEdit}
        <Button size="sm" variant="outline" class="h-7" onclick={unarchive} disabled={busy} data-testid="drive-banner-unarchive"
          >Unarchive</Button
        >
      {/if}
    {:else if archivedIn}
      <span class="min-w-0 flex-1"
        >This {item.type} is inside
        <a class="underline-offset-2 hover:underline" href={resolve(`/drive/folder/${archivedIn.id}`)}
          >“{archivedIn.name}”</a
        >, which is archived.</span
      >
    {/if}
    {#if error}
      <span class="w-full text-destructive" role="alert">{error}</span>
    {/if}
  </div>
{/if}
