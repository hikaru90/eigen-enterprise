<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- setup hrefs go through appHref(), which calls resolve() */
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { currentAreaTab } from '$lib/shell/area-nav'
  import { appHref } from '$lib/shell/href'
  import { EMAIL_SETUP_TABS, EMAIL_TABS } from './tabs'

  /** The Email area: one header with status, mail first, setup sections behind the Setup tab. */
  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const current = $derived(currentAreaTab(EMAIL_TABS, page.url.pathname))
  const setupCurrent = $derived(currentAreaTab(EMAIL_SETUP_TABS, page.url.pathname))
  // The module pill is the activation, like every module page; the SES connection lives under Setup › Account.
  const status = $derived({
    label: data.email.active ? 'Active' : 'Not active',
    on: data.email.active,
  })
</script>

<PageFrame testid="email-area">
  <PageHeader
    title="Email"
    description="Your company's mail: what is waiting to go out and what was sent. Setup holds the Amazon SES account, domains, senders, flows, logs and the API."
    {status}
    tabs={EMAIL_TABS}
    {current}
    navLabel="Email sections"
    navTestId="email-nav"
    tabTestId={(id) => `email-tab-${id}`}
  />
  {#if current === 'setup'}
    <nav
      class="-mt-2 mb-6 flex flex-wrap gap-1"
      aria-label="Email setup sections"
      data-testid="email-setup-nav"
    >
      {#each EMAIL_SETUP_TABS as tab (tab.id)}
        <a
          href={appHref(tab.href)}
          aria-current={setupCurrent === tab.id ? 'page' : undefined}
          data-testid={`email-setup-tab-${tab.id}`}
          class="rounded-md px-2.5 py-1 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 {setupCurrent ===
          tab.id
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground'}">{tab.label}</a
        >
      {/each}
    </nav>
  {/if}
  {@render children()}
</PageFrame>
