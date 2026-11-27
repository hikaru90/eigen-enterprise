<script lang="ts">
  import type { PageData } from './$types'
  import DriveBrowser from '$lib/components/drive/drive-browser.svelte'
  import { getCompanyPresence } from '$lib/presence/company-presence.svelte'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
  /** Who has which row open (plan/phase-multiplayer-presence.md); null while the presence feed is off. */
  const company = getCompanyPresence()
</script>

<svelte:head><title>{docTitle(data.origin === 'mine' ? 'My drive' : 'Overview', 'Drive')}</title></svelte:head>

<DriveBrowser
  {company}
  folderId={null}
  path={[]}
  root={data.root}
  items={data.items}
  canEdit={data.canEdit}
  origin={data.origin}
  query={data.query}
  results={data.results}
  describe={data.describe}
  emptyText="Your drive is empty."
  emptyHint="Folders and files you create or upload here land in My drive; shared items, Messages attachments, and connected sources appear here too."
/>
