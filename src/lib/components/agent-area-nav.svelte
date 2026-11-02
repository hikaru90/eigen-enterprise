<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'

  /** The Agent area's sub-navigation: Runs · Activity · Roadmap, one URL each. */
  const links = [
    { id: 'runs', name: 'Runs', href: resolve('/agent/runs'), path: '/agent/runs' },
    { id: 'activity', name: 'Activity', href: resolve('/agent/activity'), path: '/agent/activity' },
    { id: 'roadmap', name: 'Roadmap', href: resolve('/agent/roadmap'), path: '/agent/roadmap' },
  ] as const

  const isCurrent = (path: string) =>
    page.url.pathname === path || page.url.pathname.startsWith(`${path}/`)
</script>

<div class="flex flex-col gap-3">
  <p class="text-[11px] font-medium text-foreground/50">Agent</p>
  <nav
    class="-mx-1 flex gap-1 overflow-x-auto border-b border-border pb-px"
    aria-label="Agent sections"
    data-testid="agent-area-nav"
  >
    {#each links as link (link.id)}
      <a
        href={link.href}
        aria-current={isCurrent(link.path) ? 'page' : undefined}
        data-testid="agent-nav-{link.id}"
        class="-mb-px shrink-0 border-b-2 px-2 py-2 text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60
          {isCurrent(link.path)
          ? 'border-foreground font-medium text-foreground'
          : 'border-transparent text-foreground/60 hover:text-foreground'}">{link.name}</a
      >
    {/each}
  </nav>
</div>
