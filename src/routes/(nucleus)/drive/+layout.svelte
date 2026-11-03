<script lang="ts">
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { currentAreaTab, DRIVE_TABS } from '$lib/shell/area-nav'

  /** The Drive area: one header, My drive · Shared with me · Trash below it. */
  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const current = $derived(currentAreaTab(DRIVE_TABS, page.url.pathname))
</script>

<PageFrame testid="drive-page">
  <PageHeader
    title={data.drive.name}
    description="The company's folders and files. Share them with people, groups or everyone."
    status={{ label: data.drive.active ? 'Active' : 'Not active', on: data.drive.active }}
    tabs={DRIVE_TABS}
    {current}
    navLabel="Drive sections"
    navTestId="drive-nav"
    tabTestId={(id) => `drive-tab-${id}`}
  >
    {#snippet actions()}
      <span class="text-xs text-muted-foreground" data-testid="drive-storage">{data.drive.storageUsed} used</span>
    {/snippet}
  </PageHeader>
  {@render children()}
</PageFrame>
