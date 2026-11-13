<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- tab hrefs go through appHref(), which calls resolve() */
  import type { Snippet } from 'svelte'
  import type { AreaTab } from '$lib/shell/area-nav'
  import { appHref } from '$lib/shell/href'
  import StatusPill from './status-pill.svelte'

  /**
   * The one page header (C3b): h1 title, optional one-line description,
   * optional status pill, optional actions on the right, optional sub-nav
   * tabs below. Every area page in the shell uses it.
   */
  let {
    title,
    description,
    status,
    actions,
    tabs,
    current,
    navLabel,
    navTestId,
    tabTestId = (id: string) => `area-tab-${id}`,
  }: {
    title: string
    description?: string | null
    status?: { label: string; on: boolean } | null
    actions?: Snippet
    tabs?: readonly Pick<AreaTab, 'id' | 'label' | 'href'>[]
    current?: string | null
    navLabel?: string
    navTestId?: string
    tabTestId?: (id: string) => string
  } = $props()
</script>

<header class="flex min-w-0 flex-col" data-testid="page-header">
  <div class="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3">
    <div class="min-w-0">
      <div class="flex min-w-0 items-center gap-3">
        <h1 class="display-l min-w-0 truncate pb-1">{title}</h1>
        {#if status}<StatusPill label={status.label} on={status.on} />{/if}
      </div>
      {#if description}
        <p class="mt-2 max-w-[60ch] text-[15px] text-muted-foreground" data-testid="page-description">
          {description}
        </p>
      {/if}
    </div>
    {#if actions}
      <div class="flex shrink-0 flex-wrap items-center gap-2" data-testid="page-actions">
        {@render actions()}
      </div>
    {/if}
  </div>
  {#if tabs && tabs.length > 0}
    <!-- The website's nav capsule: pills on a grey track, the current one inked. -->
    <nav
      class="mt-6 flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full bg-card p-1"
      aria-label={navLabel ?? `${title} sections`}
      data-testid={navTestId}
    >
      {#each tabs as tab (tab.id)}
        <a
          href={appHref(tab.href)}
          aria-current={current === tab.id ? 'page' : undefined}
          data-testid={tabTestId(tab.id)}
          class="shrink-0 rounded-full px-4 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring {current ===
          tab.id
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:bg-background hover:text-foreground'}">{tab.label}</a
        >
      {/each}
    </nav>
  {/if}
</header>
