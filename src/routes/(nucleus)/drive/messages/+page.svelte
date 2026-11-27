<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { getCompanyPresence } from '$lib/presence/company-presence.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
  /** Who has which row open (plan/phase-multiplayer-presence.md); null while the presence feed is off. */
  const company = getCompanyPresence()
</script>

<svelte:head><title>{docTitle('Messages', 'Drive')}</title></svelte:head>

<DriveBrowser
  {company}
  folderId={null}
  root={{ label: 'Messages', href: '/drive/messages' }}
  items={data.items}
  describe={data.describe}
  canEdit={false}
  showToolbar={false}
  emptyText="No attachments yet."
  emptyHint="Files shared in a conversation in Messages land here, one folder per conversation."
/>
