<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import { resolve } from '$app/paths'
  import { useAssistant } from '$lib/components/assistant/context'
  import ModuleCard from '$lib/components/module-card.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import type { Dashboard } from '$lib/server/overview/dashboard'
  import { appHref } from '$lib/shell/href'
  import { moduleHref, type ShellNavItem } from '$lib/shell/nav'

  /**
   * The dashboard at `/` (polish P-2, formerly /overview): a greeting, what
   * needs the member, the modules at work, the agent's recent actions and the
   * ways into the rest of the company. Full width (P-3).
   */
  let {
    dashboard,
    greetingName,
    companyName,
    navItems,
    isAdmin,
  }: {
    dashboard: Dashboard
    greetingName: string | null
    companyName: string | null
    navItems: readonly ShellNavItem[]
    /** Owner/admin manage members and invites. */
    isAdmin: boolean
  } = $props()

  const assistant = useAssistant()

  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))

  const overview = $derived(dashboard.overview)
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
      href={website ? appHref(moduleHref(website.id)) : '#modules'}
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
              <ModuleCard {module} />
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <div class="flex min-w-0 flex-col gap-10">
      <!-- Recent activity -->
      <section class="min-w-0" data-testid="dashboard-activity">
        <div class="flex items-baseline justify-between gap-2">
          <h2 class="text-[13px] font-medium">Recent activity</h2>
          <a
            href={resolve('/assistant/activity')}
            class="text-xs text-foreground/55 hover:text-foreground hover:underline">All activity</a
          >
        </div>
        {#if overview.actions.length === 0}
          <p class="mt-2 text-sm text-foreground/55">Nothing yet.</p>
        {:else}
          <ol class="mt-3 border-l border-border" data-testid="overview-actions">
            {#each overview.actions as action, i (i)}
              <li class="relative min-w-0 pb-4 pl-4 last:pb-0">
                <span
                  class="absolute top-1.5 -left-[3.5px] size-1.5 rounded-full {action.ok
                    ? 'bg-foreground/35'
                    : 'bg-red-500'}"
                  aria-hidden="true"
                ></span>
                <p class="text-sm leading-snug wrap-break-word">
                  {action.text}{#if !action.ok}<span class="text-xs text-red-600">
                      · failed</span
                    >{/if}
                </p>
                <time class="text-xs text-foreground/45" datetime={action.at}
                  >{when(action.at)}</time
                >
              </li>
            {/each}
          </ol>
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
          {#if isAdmin}
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
