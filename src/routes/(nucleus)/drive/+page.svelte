<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import DrivePrivacyNote from '$lib/components/drive/drive-privacy-note.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('My drive', 'Drive')}</title></svelte:head>

<div class="px-4 pt-4"><DrivePrivacyNote /></div>

<DriveBrowser
  folderId={null}
  path={[]}
  items={data.listing.items}
  canEdit={data.listing.canEdit}
  query={data.query}
  results={data.results}
  describe={data.describe}
  emptyText="Your drive is empty."
  emptyHint="Folders and files you create or upload here are yours; share them with people, groups or everyone."
/>
