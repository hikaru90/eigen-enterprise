<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('My drive', 'Drive')}</title></svelte:head>

<DriveBrowser folderId={null} path={[]} items={data.listing.items} canEdit={data.listing.canEdit} query={data.query} results={data.results} />
