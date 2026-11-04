<script lang="ts">
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { activeMemorySurfaceTab, MEMORY_TABS } from '$lib/memory/memory-surface-nav'

  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const current = $derived(activeMemorySurfaceTab(page.url.pathname))
  const tabs = MEMORY_TABS.map((t) => ({ id: t.id, label: t.label, href: t.href }))
</script>

<!-- The Memory module page: the one page header with status, tabs below.
     Full-height app layout (Capture/Notes fill the pane), so it is its own
     frame rather than PageFrame's padded column — still full width (P-3). -->
<div class="flex min-h-0 w-full flex-1 flex-col" data-page-frame data-testid="memory-page">
  <div class="w-full px-4 pt-6 sm:px-8 sm:pt-10">
    <PageHeader
      title={data.memory.name}
      description="Tasks, projects and notes you and the agent keep — and a place to capture a thought."
      status={{ label: data.memory.active ? 'Active' : 'Not active', on: data.memory.active }}
      {tabs}
      {current}
      navLabel="Memory sections"
      navTestId="memory-nav"
      tabTestId={(id) => `memory-tab-${id}`}
    />
  </div>
  <div class="flex min-h-0 w-full flex-1 flex-col">
    {@render children()}
  </div>
</div>
