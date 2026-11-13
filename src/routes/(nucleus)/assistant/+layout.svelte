<script lang="ts">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { ASSISTANT_TABS, currentAreaTab } from '$lib/shell/area-nav'

  /**
   * The assistant's linkable pages (polish P-1): one header, Conversations ·
   * Activity below it. The same lists are the assistant panel's History and
   * Activity tabs; the chat itself is the panel.
   * Activity (the company's log) is core: with the Assistant switched off it
   * stays, and the Conversations tab (the Assistant's page) is not offered.
   */
  let { children }: { children: Snippet } = $props()
  const tabs = $derived(
    (page.data as { shell?: { assistant?: boolean } | null }).shell?.assistant === true
      ? ASSISTANT_TABS
      : ASSISTANT_TABS.filter((t) => t.id !== 'conversations'),
  )
  const current = $derived(currentAreaTab(tabs, page.url.pathname))
</script>

<PageFrame>
  <PageHeader
    title="Assistant"
    description="Everything the company's assistant talked about and did, live as it happens."
    {tabs}
    {current}
    navLabel="Assistant sections"
    navTestId="assistant-area-nav"
    tabTestId={(id) => `assistant-nav-${id}`}
  />
  {@render children()}
</PageFrame>
