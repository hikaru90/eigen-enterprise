<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import { resolve } from '$app/paths'
  import { canOpen, type Capabilities } from '$lib/access/capabilities'
  import { useAssistant } from '$lib/components/assistant/context'
  import ModuleCard from '$lib/components/module-card.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import type { Dashboard } from '$lib/server/overview/dashboard'
  import { appHref } from '$lib/shell/href'
  import type { ShellNavItem } from '$lib/shell/nav'
  import { groupActionsByDay } from './activity-groups'

  /**
   * The dashboard at `/` (polish P-2, formerly /overview): a greeting, what
   * needs the member, the modules at work, the agent's recent actions and the
   * ways into the rest of the company. Full width (P-3). Every link here is
   * one this person may open: module cards and the Apps tile link to the
   * module's nav entry (the nav leaves out pages they can't open), the invite
   * link follows the capability set.
   */
  let {
    dashboard,
    greetingName,
    companyName,
    navItems,
    capabilities,
    providerMissing,
  }: {
    dashboard: Dashboard
    greetingName: string | null
    companyName: string | null
    navItems: readonly ShellNavItem[]
    /** The shell's capability set (who may manage members and invites, …). */
    capabilities: Capabilities
    /** The company's AI provider is not connected: the assistant cannot work until it is. */
    providerMissing: boolean
  } = $props()

  const assistant = useAssistant()

  const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))

  const overview = $derived(dashboard.overview)
  const actionGroups = $derived(groupActionsByDay(overview.actions, new Date()))
  const activeModules = $derived(overview.modules.filter((m) => m.active))
  const switchedOff = $derived(overview.modules.length - activeModules.length)
  const needsYou = $derived(overview.approvals.length + (dashboard.backup ? 1 : 0))
  const website = $derived(overview.modules.find((m) => m.id === 'website') ?? null)
  const countOf = (label: string) => website?.counts.find((c) => c.label === label)?.value ?? 0
  const apps = $derived.by(() => {
    if (!website || !website.active) return { value: 'Off', hint: 'Website module not active' }
    const total = countOf('Apps')
    if (total === 0) return { value: '—', hint: website.note ?? 'No apps yet' }
    return { value: String(total), hint: `${countOf('Healthy')} healthy` }
  })
  const title = $derived(greetingName ? `Welcome back, ${greetingName}` : 'Welcome back')
  const quickLinks = $derived(navItems.filter((i) => i.active && i.id !== 'settings'))
  /** A module's page as the nav lists it for this person; null = not theirs to open. */
  const pageOf = (id: string) => navItems.find((i) => i.id === id)?.href ?? null
  const websitePage = $derived(website ? pageOf(website.id) : null)
  const canInvite = $derived(canOpen(capabilities, '/settings/members'))

  /** Drafts for the assistant: they wait in its composer, never sent on their own. */
  const suggestions = [
    'What happened in the company today?',
    'What should I look at next?',
    'Build me a landing page for a new offer',
  ]

  const tile =
    'flex min-w-0 flex-col rounded-lg border border-border bg-background px-4 py-3.5 text-left transition-colors outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/60'
  const sideLink =
    'group flex min-w-0 items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm outline-none hover:bg-primary/[0.05] focus-visible:ring-2 focus-visible:ring-ring/60'
</script>

<PageFrame testid="dashboard">
  <PageHeader
    {title}
    description={companyName
      ? `What is happening at ${companyName}, and what needs you.`
      : 'What is happening in your company, and what needs you.'}
  />

  {#if providerMissing}
    <!-- Kept from the former full-screen gate: without a provider the assistant cannot work. -->
    <div
      class="mt-6 flex min-w-0 flex-col gap-3 rounded-lg border border-primary/30 bg-primary/[0.05] px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
      data-testid="dashboard-provider-notice"
    >
      <span class="min-w-0">
        <span class="font-medium">Connect your AI provider.</span>
        <span class="text-foreground/60"
          >The assistant and agents work once a provider is connected.</span
        >
      </span>
      <a
        href={resolve('/settings/llm')}
        class="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60"
        data-testid="dashboard-provider-connect">Connect provider</a
      >
    </div>
  {/if}

  <!-- Ask: the assistant is one keystroke away on every page; here it is the first thing. -->
  <section
    class="mt-6 flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4 sm:flex-row sm:items-center"
    aria-label="Ask the assistant"
    data-testid="dashboard-ask"
  >
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2.5 rounded-md border border-border bg-background px-3 py-2.5 text-left text-sm text-foreground/55 outline-none hover:border-foreground/25 focus-visible:ring-2 focus-visible:ring-ring/60"
      onclick={() => assistant.focusBar()}
      data-testid="dashboard-ask-button"
    >
      <Sparkles class="size-4 shrink-0 text-primary" aria-hidden="true" strokeWidth={1.75} />
      <span class="min-w-0 truncate">Ask the assistant anything, or ask it to do the work…</span>
    </button>
    <div class="flex min-w-0 flex-wrap gap-1.5">
      {#each suggestions as text (text)}
        <button
          type="button"
          class="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground/70 outline-none hover:border-foreground/25 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          onclick={() => assistant.prefill(text)}
          data-testid="dashboard-suggestion">{text}</button
        >
      {/each}
    </div>
  </section>

  <!-- Status tiles -->
  <div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="overview-tiles">
    <a href="#needs-you" class={tile} data-testid="dashboard-needs-you-tile">
      <span class="text-xs text-foreground/55">Needs you</span>
      <span class="mt-1 flex items-center gap-2 text-2xl font-semibold tabular-nums">
        {needsYou}
        {#if needsYou > 0}<span class="size-2 rounded-full bg-eigen-green" aria-hidden="true"
          ></span>{/if}
      </span>
      <span class="mt-0.5 text-xs text-foreground/45">Approvals and warnings</span>
    </a>
    <a href="#modules" class={tile}>
      <span class="text-xs text-foreground/55">Modules working for you</span>
      <span class="mt-1 text-2xl font-semibold tabular-nums">{activeModules.length}</span>
      <span class="mt-0.5 text-xs text-foreground/45" data-testid="overview-modules-hint"
        >{switchedOff === 0
          ? 'All switched on'
          : `${switchedOff} switched off — ask the assistant to turn ${switchedOff === 1 ? 'it' : 'them'} on`}</span
      >
    </a>
    <a
      href={websitePage ? appHref(websitePage) : '#modules'}
      class={tile}
      data-testid="overview-site-tile"
    >
      <span class="text-xs text-foreground/55">Apps</span>
      <span class="mt-1 text-2xl font-semibold">{apps.value}</span>
      <span class="mt-0.5 truncate text-xs text-foreground/45">{apps.hint}</span>
    </a>
  </div>

  <div class="mt-10 grid min-w-0 grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_340px]">
    <div class="min-w-0">
      <!-- Needs you -->
      <section id="needs-you" class="scroll-mt-6" data-testid="overview-approvals">
        <h2 class="text-[13px] font-medium">Needs you</h2>
        {#if dashboard.backup}
          <div
            class="mt-2 flex min-w-0 items-center justify-between gap-3 rounded-lg border border-red-700/40 px-4 py-2.5 text-sm"
            data-testid="overview-backup-notice"
            data-kind={dashboard.backup.kind}
          >
            <span class="flex min-w-0 items-center gap-2.5">
              <span class="size-1.5 shrink-0 rounded-full bg-red-700" aria-hidden="true"></span>
              <span class="min-w-0 truncate">{dashboard.backup.text}</span>
            </span>
            <a
              href={resolve('/settings/backups')}
              class="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
              >Open backups</a
            >
          </div>
        {/if}
        {#if overview.approvals.length === 0 && !dashboard.backup}
          <p class="mt-2 rounded-lg border border-border px-4 py-3 text-sm text-foreground/55">
            Nothing waiting on you.
          </p>
        {:else if overview.approvals.length > 0}
          <ul class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {#each overview.approvals as approval (approval.id)}
              <li class="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span class="flex min-w-0 items-center gap-2.5">
                  <span class="size-1.5 shrink-0 rounded-full bg-eigen-green" aria-hidden="true"
                  ></span>
                  <span class="min-w-0 truncate">{approval.text}</span>
                </span>
                <!-- Approval cards are decided in the conversation that raised them. -->
                <button
                  type="button"
                  onclick={() => assistant.openPanel('chat')}
                  class="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
                  data-testid="overview-approval-review">Review</button
                >
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Active modules -->
      <section id="modules" class="mt-10 scroll-mt-6">
        <h2 class="text-[13px] font-medium">Modules</h2>
        {#if activeModules.length === 0}
          <p class="mt-2 text-sm text-foreground/55">No module is active yet.</p>
        {:else}
          <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {#each activeModules as module (module.id)}
              <ModuleCard {module} href={pageOf(module.id)} />
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <div class="flex min-w-0 flex-col gap-10">
      <!-- Recent activity: one card, grouped by day, the time muted beside each item. -->
      <section
        class="min-w-0 overflow-hidden rounded-lg border border-border bg-muted/30"
        data-testid="dashboard-activity"
      >
        <div class="flex items-baseline justify-between gap-2 border-b border-border px-4 py-3">
          <h2 class="text-[13px] font-medium">Recent activity</h2>
          <a
            href={resolve('/assistant/activity')}
            class="text-xs text-foreground/55 hover:text-foreground hover:underline">All activity</a
          >
        </div>
        {#if actionGroups.length === 0}
          <p class="px-4 py-3 text-sm text-foreground/55">Nothing yet.</p>
        {:else}
          <div class="flex flex-col gap-3 p-3" data-testid="overview-actions">
            {#each actionGroups as group (group.label)}
              <div class="min-w-0" data-testid="overview-actions-group">
                <h3
                  class="px-1 pb-1.5 text-[11px] font-medium tracking-wide text-foreground/45 uppercase"
                >
                  {group.label}
                </h3>
                <ol
                  class="divide-y divide-border overflow-hidden rounded-md border border-border bg-background"
                >
                  {#each group.actions as action, i (i)}
                    <li class="flex min-w-0 items-start gap-2.5 px-3 py-2">
                      <span
                        class="mt-1.5 size-1.5 shrink-0 rounded-full {action.ok
                          ? 'bg-foreground/30'
                          : 'bg-red-500'}"
                        aria-hidden="true"
                      ></span>
                      <p class="min-w-0 flex-1 text-sm leading-snug wrap-break-word">
                        {action.text}{#if !action.ok}<span class="text-xs text-red-600">
                            · failed</span
                          >{/if}
                      </p>
                      <time
                        class="shrink-0 pt-0.5 text-[11px] text-foreground/40 tabular-nums"
                        datetime={action.at}>{when(action.at)}</time
                      >
                    </li>
                  {/each}
                </ol>
              </div>
            {/each}
          </div>
        {/if}
      </section>

      <!-- Quick links -->
      <section class="min-w-0" data-testid="dashboard-quick-links">
        <h2 class="text-[13px] font-medium">Go to</h2>
        <ul class="mt-2 flex flex-col gap-px">
          {#each quickLinks as item (item.id)}
            <li>
              <a href={appHref(item.href)} class={sideLink} data-testid="dashboard-link-{item.id}">
                <span class="min-w-0 truncate">{item.name}</span>
                <ArrowUpRight
                  class="size-3.5 shrink-0 text-foreground/30 group-hover:text-foreground/60"
                  aria-hidden="true"
                />
              </a>
            </li>
          {/each}
          <li>
            <a href={resolve('/assistant')} class={sideLink} data-testid="dashboard-link-assistant">
              <span class="min-w-0 truncate">Assistant conversations</span>
              <ArrowUpRight
                class="size-3.5 shrink-0 text-foreground/30 group-hover:text-foreground/60"
                aria-hidden="true"
              />
            </a>
          </li>
          {#if canInvite}
            <li>
              <a
                href={resolve('/settings/members')}
                class={sideLink}
                data-testid="dashboard-link-invite"
              >
                <span class="min-w-0 truncate">Invite a teammate</span>
                <ArrowUpRight
                  class="size-3.5 shrink-0 text-foreground/30 group-hover:text-foreground/60"
                  aria-hidden="true"
                />
              </a>
            </li>
          {/if}
        </ul>
      </section>
    </div>
  </div>
</PageFrame>
