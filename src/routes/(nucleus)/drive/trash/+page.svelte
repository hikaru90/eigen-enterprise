<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('Trash', 'Drive')}</title></svelte:head>

<p class="mt-6 text-sm text-muted-foreground">Restore puts an item back where it was. Delete forever can’t be undone.</p>
<DriveBrowser folderId={null} items={data.items} canEdit={false} showToolbar={false} trashView emptyText="The trash is empty." />
