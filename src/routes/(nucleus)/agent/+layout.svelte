<script lang="ts">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { AGENT_TABS, currentAreaTab } from '$lib/shell/area-nav'

  /** The Agent area: one header, Runs · Activity · Roadmap below it. */
  let { children }: { children: Snippet } = $props()
  const current = $derived(currentAreaTab(AGENT_TABS, page.url.pathname))
</script>

<PageFrame>
  <PageHeader
    title="Agent"
    description="What the agent does for the company: its conversations, its log and its plans."
    tabs={AGENT_TABS}
    {current}
    navLabel="Agent sections"
    navTestId="agent-area-nav"
    tabTestId={(id) => `agent-nav-${id}`}
  />
  {@render children()}
</PageFrame>
