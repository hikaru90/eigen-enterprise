<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
</script>

<svelte:head><title>{docTitle('Shared with me', 'Drive')}</title></svelte:head>

<DriveBrowser folderId={null} root={{ label: 'Shared with me', href: '/drive/shared' }} items={data.items} canEdit={false} showToolbar={false} emptyText="Nobody has shared anything with you yet." />
