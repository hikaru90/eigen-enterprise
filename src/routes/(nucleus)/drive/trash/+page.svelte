<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('Trash', 'Drive')}</title></svelte:head>

<DriveBrowser
  folderId={null}
  items={data.items}
  describe={data.describe}
  canEdit={false}
  showToolbar={false}
  trashView
  note="Restore puts an item back where it was. Delete forever can’t be undone."
  emptyText="The trash is empty."
/>
