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
    root={data.listing.root}
    items={data.listing.items}
    canEdit={data.listing.canEdit}
    query={data.query}
    results={data.results}
    describe={data.describe}
    emptyText="This folder is empty."
  />
{/key}
