<script lang="ts">
  import { resolve } from '$app/paths'
  import { page } from '$app/state'

  /**
   * The Agent area until the Agent page (C3) folds them together: Runs,
   * Activity and the Roadmap, one link row so none of them is a dead end.
   */
  const links = [
    { id: 'runs', name: 'Runs', href: resolve('/runs'), path: '/runs' },
    { id: 'activity', name: 'Activity', href: resolve('/activity'), path: '/activity' },
    {
      id: 'roadmap',
      name: 'Roadmap',
      href: resolve('/settings/extensions'),
      path: '/settings/extensions',
    },
  ] as const

  const isCurrent = (path: string) =>
    page.url.pathname === path || page.url.pathname.startsWith(`${path}/`)
</script>

<nav class="flex gap-1 border-b border-border pb-px" aria-label="Agent" data-testid="agent-area-nav">
  {#each links as link (link.id)}
    <a
      href={link.href}
      aria-current={isCurrent(link.path) ? 'page' : undefined}
      class="-mb-px border-b-2 px-2 py-2 text-[13px] {isCurrent(link.path)
        ? 'border-foreground font-medium text-foreground'
        : 'border-transparent text-foreground/60 hover:text-foreground'}">{link.name}</a
    >
  {/each}
</nav>
