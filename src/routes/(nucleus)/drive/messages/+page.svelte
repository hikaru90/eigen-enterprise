<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('Messages', 'Drive')}</title></svelte:head>

<DriveBrowser
  folderId={null}
  root={{ label: 'Messages', href: '/drive/messages' }}
  items={data.items}
  describe={data.describe}
  canEdit={false}
  showToolbar={false}
  emptyText="No attachments yet."
  emptyHint="Files shared in a conversation in Messages land here, one folder per conversation."
/>
