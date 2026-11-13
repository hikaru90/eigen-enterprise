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
        <h1 class="min-w-0 truncate text-[1.375rem] leading-tight font-medium tracking-[-0.02em]">{title}</h1>
        {#if status}<StatusPill label={status.label} on={status.on} />{/if}
      </div>
      {#if description}
        <p class="mt-1.5 max-w-[65ch] text-sm text-muted-foreground" data-testid="page-description">
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
    <!-- Controls are pills: a pill track, the current tab the white pill on it. -->
    <nav
      class="mt-5 flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-full bg-muted p-1"
      aria-label={navLabel ?? `${title} sections`}
      data-testid={navTestId}
    >
      {#each tabs as tab (tab.id)}
        <a
          href={appHref(tab.href)}
          aria-current={current === tab.id ? 'page' : undefined}
          data-testid={tabTestId(tab.id)}
          class="shrink-0 rounded-full px-3.5 py-1.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring {current ===
          tab.id
            ? 'bg-card font-medium text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.08)]'
            : 'text-muted-foreground hover:text-foreground'}">{tab.label}</a
        >
      {/each}
    </nav>
  {/if}
</header>
