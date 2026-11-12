<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- setup hrefs go through appHref(), which calls resolve() */
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { currentAreaTab } from '$lib/shell/area-nav'
  import { appHref } from '$lib/shell/href'
  import { EMAIL_SETUP_TABS, emailTabs } from './tabs'

  /** The Email area: one header with status, mail first, setup sections behind the Setup tab. */
  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const tabs = $derived(emailTabs(data.email))
  const current = $derived(currentAreaTab(tabs, page.url.pathname))
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
    description="Your inbox and the mailboxes you share. Company mail shows what the company is sending; Setup holds the Amazon SES account, domains, mailboxes, senders, flows, logs and the API."
    {status}
    {tabs}
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
