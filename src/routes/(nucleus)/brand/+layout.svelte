<script lang="ts">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { BRAND_TABS, currentAreaTab, openableTabs } from '$lib/shell/area-nav'
  import { ownerModuleBlurb } from '$lib/shell/module-copy'

  /**
   * The Brand area: one header, Style · Design system · Extract below it.
   * The set editor is a full-pane tool and renders without the frame.
   */
  let { children }: { children: Snippet } = $props()
  const current = $derived(currentAreaTab(BRAND_TABS, page.url.pathname))
  // Extract and the editor are for owners/admins (brand.extract): a member
  // is not offered a tab that answers 403.
  const tabs = $derived(page.data.shell ? openableTabs(BRAND_TABS, page.data.shell.capabilities) : [])
</script>

{#if current}
  <PageFrame>
    <PageHeader
      title="Brand"
      description={ownerModuleBlurb('brand', '')}
      {tabs}
      {current}
      navLabel="Brand sections"
      navTestId="brand-nav"
      tabTestId={(id) => `brand-tab-${id}`}
    />
    {@render children()}
  </PageFrame>
{:else}
  {@render children()}
{/if}
