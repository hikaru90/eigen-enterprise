<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'
  import { activeMemorySurfaceTab } from '$lib/memory/memory-surface-nav'
  import { m } from '$lib/paraglide/messages.js'

  /** Memory's sections, one tab row inside the shell (the graph view is gone). */
  const tabs = [
    { id: 'tasks', label: () => m.memory_tab_tasks(), href: resolve('/memory/tasks') },
    { id: 'projects', label: () => m.memory_tab_projects(), href: resolve('/memory/projects') },
    { id: 'notes', label: () => m.memory_tab_notes(), href: resolve('/memory/notes') },
    { id: 'capture', label: () => 'Capture', href: resolve('/capture') },
  ] as const

  const activeTab = $derived(activeMemorySurfaceTab(page.url.pathname))
</script>

<nav
  class="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-4 pb-px md:px-8"
  aria-label={m.memory_aria_view_tabs()}
  data-testid="memory-nav"
>
  {#each tabs as tab (tab.id)}
    <a
      href={tab.href}
      aria-current={activeTab === tab.id ? 'page' : undefined}
      class="-mb-px shrink-0 border-b-2 px-2 py-2.5 text-[13px] whitespace-nowrap {activeTab ===
      tab.id
        ? 'border-foreground font-medium text-foreground'
        : 'border-transparent text-foreground/60 hover:text-foreground'}">{tab.label()}</a
    >
  {/each}
</nav>
