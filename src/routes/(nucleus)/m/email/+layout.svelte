<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- section hrefs go through appHref(), which calls resolve() */
  import type { LayoutData } from './$types'
  import type { Snippet } from 'svelte'
  import type { AreaTab } from '$lib/shell/area-nav'
  import { page } from '$app/state'
  import MailKindsInfo from '$lib/components/email/mail-kinds-info.svelte'
  import { MAIL_KINDS, mailKindOfTab } from '$lib/components/email/mail-kinds'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { currentAreaTab } from '$lib/shell/area-nav'
  import { appHref } from '$lib/shell/href'
  import { EMAIL_SETUP_TABS, emailMarketingTabs, emailTabs } from './tabs'

  /**
   * The Email area: one header with status, the three kinds of mail first (personal, transactional, marketing —
   * Contribute d7080d17), each tab saying in one line what it holds, the rules behind one info button; Contacts;
   * setup sections behind the Setup tab.
   */
  let { data, children }: { data: LayoutData; children: Snippet } = $props()
  const tabs = $derived(emailTabs(data.email))
  const current = $derived(currentAreaTab(tabs, page.url.pathname))
  const kind = $derived(mailKindOfTab(current))
  /** The second row of sections under Marketing mail or Setup, with its test id prefix. */
  const sections = $derived<{ tabs: readonly AreaTab[]; label: string; id: string } | null>(
    current === 'setup'
      ? { tabs: EMAIL_SETUP_TABS, label: 'Email setup sections', id: 'setup' }
      : current === 'marketing'
        ? { tabs: emailMarketingTabs(data.email), label: 'Marketing mail sections', id: 'marketing' }
        : null,
  )
  const sectionCurrent = $derived(sections ? currentAreaTab(sections.tabs, page.url.pathname) : null)
  // The module pill is the activation, like every module page; the SES connection lives under Setup › Account.
  const status = $derived({
    label: data.email.active ? 'Active' : 'Not active',
    on: data.email.active,
  })
  const description = $derived(
    kind
      ? MAIL_KINDS[kind].line
      : current === 'people'
        ? 'The people you know: where you met, why they matter, what to do next.'
        : 'How your company sends and receives mail: the Amazon SES account, domains, senders, mailboxes, templates, logs and the API.',
  )
</script>

<PageFrame testid="email-area">
  <PageHeader
    title="Email"
    part="email"
    {status}
    {tabs}
    {current}
    navLabel="Email sections"
    navTestId="email-nav"
    tabTestId={(id) => `email-tab-${id}`}
  >
    {#snippet actions()}
      <MailKindsInfo current={kind} />
    {/snippet}
    {#snippet info()}
      <p>{description}</p>
    {/snippet}
  </PageHeader>
  {#if sections}
    <nav
      class="mt-4 mb-6 flex flex-wrap gap-1"
      aria-label={sections.label}
      data-testid={`email-${sections.id}-nav`}
    >
      {#each sections.tabs as tab (tab.id)}
        <a
          href={appHref(tab.href)}
          aria-current={sectionCurrent === tab.id ? 'page' : undefined}
          data-testid={`email-${sections.id}-tab-${tab.id}`}
          class="rounded-md px-2.5 py-1 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60 {sectionCurrent ===
          tab.id
            ? 'bg-muted font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground'}">{tab.label}</a
        >
      {/each}
    </nav>
  {/if}
  {@render children()}
</PageFrame>
