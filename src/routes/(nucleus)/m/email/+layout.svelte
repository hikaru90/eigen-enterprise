<script lang="ts">
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { currentAreaTab } from '$lib/shell/area-nav'
  import { EMAIL_TABS } from './tabs'

  /** The Email area: one header with status, the platform's sections as tabs below it. */
  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const current = $derived(currentAreaTab(EMAIL_TABS, page.url.pathname))
  // The module pill is the activation, like every module page; the SES connection lives on the Overview.
  const status = $derived({
    label: data.email.active ? 'Active' : 'Not active',
    on: data.email.active,
  })
</script>

<PageFrame testid="email-area">
  <PageHeader
    title="Email"
    description="Your company's email through your own Amazon SES account: domains, senders, every mail sent, and sending from your code."
    {status}
    tabs={EMAIL_TABS}
    {current}
    navLabel="Email sections"
    navTestId="email-nav"
    tabTestId={(id) => `email-tab-${id}`}
  />
  {@render children()}
</PageFrame>
