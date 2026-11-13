<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import Bot from '@lucide/svelte/icons/bot'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import UserPlus from '@lucide/svelte/icons/user-plus'
  import { resolve } from '$app/paths'
  import { canOpen, type Capabilities } from '$lib/access/capabilities'
  import { assistantIfOn } from '$lib/components/assistant/context'
  import DotMatrix from '$lib/components/dot-matrix.svelte'
  import ModuleCard from '$lib/components/module-card.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import type { Dashboard } from '$lib/server/overview/dashboard'
  import { appHref } from '$lib/shell/href'
  import { iconFor } from '$lib/shell/module-icon'
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

  // null while the Assistant plugin is switched off: no ask box, no way into a panel that is not there.
  const assistant = assistantIfOn()
  const canManagePlugins = $derived(canOpen(capabilities, '/settings/modules'))

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

  /** The display tile shows at most two digits, like the website's. */
  const needsYouDisplay = $derived(needsYou > 99 ? '99+' : String(needsYou))

  const statTile =
    'tile flex min-h-36 min-w-0 flex-col p-5 text-left outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const goLink =
    'group flex h-10 min-w-0 items-center gap-2.5 rounded-xl px-3 text-sm outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring'
  const inkPill =
    'inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
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
      class="tile tile-charcoal mt-6 flex min-w-0 flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between"
      data-testid="dashboard-provider-notice"
    >
      <span class="flex min-w-0 items-center gap-3.5">
        <span class="ico ico-coral" aria-hidden="true"><Sparkles class="size-4" strokeWidth={1.75} /></span>
        <span class="min-w-0">
          <span class="block font-medium">Connect your AI provider.</span>
          <span class="tile-soft block text-sm"
            >The assistant and agents work once a provider is connected.</span
          >
        </span>
      </span>
      <a
        href={resolve('/settings/llm')}
        class="inline-flex h-8 shrink-0 items-center justify-center rounded-full bg-white px-3.5 text-sm font-medium text-black outline-none hover:bg-white/90 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black"
        data-testid="dashboard-provider-connect">Connect provider</a
      >
    </div>
  {/if}

  <!-- The collage: the company at a glance — the website's hero, on calm neutral tiles. -->
  <div class="mt-6 grid min-w-0 grid-cols-1 gap-3 md:grid-cols-6 xl:grid-cols-12" data-testid="overview-tiles">
    <!-- Ask: the assistant is one keystroke away on every page; here it is the first thing. -->
    {#if assistant}
      <section
        class="tile tile-stone relative flex min-h-60 min-w-0 flex-col overflow-hidden p-5 md:col-span-6 xl:col-span-7 xl:row-span-2 sm:p-6"
        aria-label="Ask the assistant"
        data-testid="dashboard-ask"
      >
        <span class="orb pointer-events-none absolute -top-6 -right-6 size-32 sm:top-4 sm:right-4 sm:size-24" aria-hidden="true"></span>
        <p class="tile-soft relative max-w-[30ch] text-sm">
          Ask the assistant anything, or ask it to do the work.
        </p>
        <button
          type="button"
          class="display-l relative mt-auto max-w-[22ch] pt-8 text-left outline-none hover:underline hover:decoration-1 hover:underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring"
          onclick={() => assistant.focusBar()}
          data-testid="dashboard-ask-button"
        >
          What should happen in the company today?
        </button>
        <div class="relative mt-5 flex min-w-0 flex-wrap gap-1.5">
          {#each suggestions as text (text)}
            <button
              type="button"
              class="h-8 rounded-full bg-(--tile-wash) px-3.5 text-sm outline-none hover:bg-white focus-visible:ring-2 focus-visible:ring-ring"
              onclick={() => assistant.prefill(text)}
              data-testid="dashboard-suggestion">{text}</button
            >
          {/each}
        </div>
      </section>
    {/if}

    <a
      href="#needs-you"
      class="{statTile} tile-ink md:col-span-6 {assistant ? 'xl:col-span-5 xl:row-span-2' : 'xl:col-span-6'}"
      data-testid="dashboard-needs-you-tile"
    >
      <span class="flex items-center justify-between gap-2">
        <span class="ico ico-wash" aria-hidden="true"><Bot class="size-4" strokeWidth={1.75} /></span>
        <span class="chip chip-line chip-dot {needsYou > 0 ? 'chip-wait' : ''}"
          >{needsYou > 0 ? 'Waiting' : 'All clear'}</span
        >
      </span>
      <span class="my-3 block h-24 min-h-0 flex-1 xl:h-auto">
        <DotMatrix text={needsYouDisplay} lit={needsYou > 0 ? 'var(--tone-coral)' : '#ffffff'} />
      </span>
      <span class="flex items-end justify-between gap-3">
        <span class="flex min-w-0 flex-col gap-0.5">
          <span class="text-sm font-medium">Needs you <span class="sr-only">: {needsYou}</span></span>
          <span class="tile-soft text-sm">Approvals and warnings</span>
        </span>
      </span>
    </a>

    <a href="#modules" class="{statTile} tile-mist md:col-span-3 {assistant ? 'xl:col-span-4' : 'xl:col-span-3'}">
      <span class="chip chip-line w-fit">Modules</span>
      <span class="display-xl mt-auto pt-5 tabular-nums">{activeModules.length}</span>
      <span class="mt-1.5 text-sm font-medium">Working for you</span>
      <span class="tile-soft text-sm" data-testid="overview-modules-hint"
        >{switchedOff === 0
          ? 'All switched on'
          : assistant
            ? `${switchedOff} switched off — ask the assistant to turn ${switchedOff === 1 ? 'it' : 'them'} on`
            : `${switchedOff} switched off`}</span
      >
    </a>
    <a
      href={websitePage ? appHref(websitePage) : '#modules'}
      class="{statTile} tile-mist md:col-span-3 {assistant ? 'xl:col-span-4' : 'xl:col-span-3'}"
      data-testid="overview-site-tile"
    >
      <span class="chip chip-line w-fit">Apps</span>
      <span class="display-xl mt-auto pt-5">{apps.value}</span>
      <span class="mt-1.5 text-sm font-medium">On your website</span>
      <span class="tile-soft truncate text-sm">{apps.hint}</span>
    </a>
    <a
      href={resolve('/assistant/activity')}
      class="{statTile} tile-slate grain md:col-span-6 {assistant ? 'xl:col-span-4' : 'xl:col-span-12'}"
    >
      <span class="chip chip-line w-fit">Agents</span>
      <span class="display-xl mt-auto pt-5 tabular-nums">{overview.actions.length}</span>
      <span class="mt-1.5 text-sm font-medium">Recent actions</span>
      <span class="tile-soft text-sm">What the assistant did for the company</span>
    </a>
  </div>

  <div class="mt-10 grid min-w-0 grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_340px]">
    <div class="min-w-0">
      <!-- Needs you -->
      <section id="needs-you" class="scroll-mt-6" data-testid="overview-approvals">
        <h2 class="display-m">Needs you</h2>
        {#if dashboard.backup}
          <div
            class="mt-3 flex min-w-0 items-center justify-between gap-3 rounded-xl bg-card py-1.5 pr-1.5 pl-2.5 text-sm"
            data-testid="overview-backup-notice"
            data-kind={dashboard.backup.kind}
          >
            <span class="flex min-w-0 items-center gap-3">
              <span class="chip chip-line chip-dot chip-bad shrink-0">Backup</span>
              <span class="min-w-0 truncate">{dashboard.backup.text}</span>
            </span>
            <a href={resolve('/settings/backups')} class={inkPill}>Open backups</a>
          </div>
        {/if}
        {#if overview.approvals.length === 0 && !dashboard.backup}
          <p class="mt-3 flex items-center gap-3 rounded-xl bg-card py-2 pr-4 pl-2.5 text-sm text-muted-foreground">
            <span class="chip chip-line chip-dot text-foreground">Clear</span>
            Nothing waiting on you.
          </p>
        {:else if overview.approvals.length > 0}
          <ul class="mt-3 flex flex-col gap-1.5">
            {#each overview.approvals as approval (approval.id)}
              <li
                class="flex min-w-0 items-center justify-between gap-3 rounded-xl bg-card py-1.5 pr-1.5 pl-2.5 text-sm"
              >
                <span class="flex min-w-0 items-center gap-3">
                  <span class="chip chip-line chip-dot chip-wait shrink-0">Approve</span>
                  <span class="min-w-0 truncate">{approval.text}</span>
                </span>
                <!-- Approval cards are decided in the conversation that raised them. -->
                {#if assistant}
                  <button
                    type="button"
                    onclick={() => assistant.openPanel('chat')}
                    class={inkPill}
                    data-testid="overview-approval-review">Review</button
                  >
                {/if}
              </li>
            {/each}
          </ul>
          {#if !assistant}
            <p
              class="mt-3 text-sm text-muted-foreground"
              data-testid="overview-approvals-assistant-off"
            >
              The Assistant is switched off: approvals are decided in its conversation.{#if canManagePlugins}
                Switch it on in <a
                  href={resolve('/settings/modules')}
                  class="underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >Settings → Plugins</a
                >.{/if}
            </p>
          {/if}
        {/if}
      </section>

      <!-- Active modules: each part on its neutral tile (module-tone.ts). -->
      <section id="modules" class="mt-10 scroll-mt-6">
        <h2 class="display-m">Modules</h2>
        {#if activeModules.length === 0}
          <p class="mt-3 text-sm text-muted-foreground">No module is active yet.</p>
        {:else}
          <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {#each activeModules as module (module.id)}
              <ModuleCard {module} href={pageOf(module.id)} />
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <div class="flex min-w-0 flex-col gap-10">
      <!-- Recent activity: one tile, grouped by day, the time beside each item. -->
      <section class="tile tile-mist min-w-0 p-4" data-testid="dashboard-activity">
        <div class="flex items-center justify-between gap-2 px-1">
          <h2 class="display-m">Recent activity</h2>
          <a
            href={resolve('/assistant/activity')}
            class="chip chip-line outline-none hover:bg-background focus-visible:ring-2 focus-visible:ring-ring">All activity</a
          >
        </div>
        {#if actionGroups.length === 0}
          <p class="mt-3 px-1 text-sm text-muted-foreground">Nothing yet.</p>
        {:else}
          <div class="mt-3 flex flex-col gap-3" data-testid="overview-actions">
            {#each actionGroups as group (group.label)}
              <div class="min-w-0" data-testid="overview-actions-group">
                <h3 class="mono-label px-1 pb-1.5 text-xs text-muted-foreground">
                  {group.label}
                </h3>
                <ol class="flex flex-col gap-1">
                  {#each group.actions as action, i (i)}
                    <li class="flex min-w-0 items-start gap-2.5 rounded-lg bg-background px-3 py-2">
                      <span
                        class="mt-1.5 size-1.5 shrink-0 rounded-full {action.ok ? 'bg-success' : 'bg-destructive'}"
                        aria-hidden="true"
                      ></span>
                      <p class="min-w-0 flex-1 text-sm leading-snug wrap-break-word">
                        {action.text}{#if !action.ok}<span class="text-destructive"> · failed</span>{/if}
                      </p>
                      <time
                        class="shrink-0 pt-0.5 font-mono text-xs text-muted-foreground tabular-nums"
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

      <!-- Quick links: quiet rows, the part's icon beside its name. -->
      <section class="min-w-0" data-testid="dashboard-quick-links">
        <h2 class="display-m">Go to</h2>
        <ul class="mt-2 flex flex-col gap-0.5">
          {#each quickLinks as item (item.id)}
            {@const Icon = iconFor(item.id)}
            <li>
              <a href={appHref(item.href)} class={goLink} data-testid="dashboard-link-{item.id}">
                <Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" strokeWidth={1.75} />
                <span class="min-w-0 flex-1 truncate">{item.name}</span>
                <ArrowUpRight
                  class="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </a>
            </li>
          {/each}
          {#if assistant}
            <li>
              <a href={resolve('/assistant')} class={goLink} data-testid="dashboard-link-assistant">
                <Sparkles class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" strokeWidth={1.75} />
                <span class="min-w-0 flex-1 truncate">Assistant conversations</span>
                <ArrowUpRight
                  class="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </a>
            </li>
          {/if}
          {#if canInvite}
            <li>
              <a href={resolve('/settings/members')} class={goLink} data-testid="dashboard-link-invite">
                <UserPlus class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" strokeWidth={1.75} />
                <span class="min-w-0 flex-1 truncate">Invite a teammate</span>
                <ArrowUpRight
                  class="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground"
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
