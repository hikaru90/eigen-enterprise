<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle(data.listing.folder?.name, 'Drive')}</title></svelte:head>

{#key data.listing.folder?.id}
  <DriveBrowser
    folderId={data.listing.folder?.id ?? null}
    path={data.listing.path}
    items={data.listing.items}
    canEdit={data.listing.canEdit}
    query={data.query}
    results={data.results}
    emptyText={data.listing.canEdit ? 'This folder is empty. Drop files here or use New.' : 'This folder is empty.'}
  />
{/key}
