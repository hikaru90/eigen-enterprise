<script lang="ts">
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import { page } from '$app/state'
  import AddAppDialog from '$lib/components/add-app-dialog.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { Button } from '$lib/components/ui/button'
  import { currentAreaTab, WEBSITE_TABS } from '$lib/shell/area-nav'
  import { ownerModuleBlurb } from '$lib/shell/module-copy'

  /** The Website module page: one header with status, Apps · Site · Settings below it. */
  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const current = $derived(currentAreaTab(WEBSITE_TABS, page.url.pathname))
  let addOpen = $state(false)
</script>

<PageFrame width="full">
  <PageHeader
    title="Website"
    description={ownerModuleBlurb('website', '')}
    status={{ label: data.website.active ? 'Active' : 'Not active', on: data.website.active }}
    tabs={WEBSITE_TABS}
    {current}
    navLabel="Website sections"
    navTestId="website-nav"
    tabTestId={(id) => `website-tab-${id}`}
  >
    {#snippet actions()}
      {#if page.url.pathname === '/m/website'}
        <Button data-testid="add-app" onclick={() => (addOpen = true)}>
          <Plus class="size-4" strokeWidth={1.75} /> Add
        </Button>
      {/if}
    {/snippet}
  </PageHeader>
  {@render children()}
</PageFrame>

<AddAppDialog open={addOpen} onOpenChange={(open) => (addOpen = open)} />
