<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import Plus from '@lucide/svelte/icons/plus'
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
   * ways into the rest of the company. Full width (P-3). Laid out as the
   * owner's reference board (docs/design-system.md › Workspace): near-square
   * stages, each holding one widget — squircle, stadium or card. Every link here is
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

  /** The display shows at most two digits, like the website's. */
  const needsYouDisplay = $derived(needsYou > 99 ? '99+' : String(needsYou))
  const hint = $derived(
    switchedOff === 0
      ? 'All switched on'
      : assistant
        ? `${switchedOff} switched off — ask the assistant to turn ${switchedOff === 1 ? 'it' : 'them'} on`
        : `${switchedOff} switched off`,
  )

  const goPill =
    'group inline-flex h-8 min-w-0 items-center gap-2 rounded-full bg-card pr-3.5 pl-2.5 text-sm outline-none transition-shadow hover:shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_14px_rgb(0_0_0/0.06)] focus-visible:ring-2 focus-visible:ring-ring'
  const inkPill =
    'inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const stageLink =
    'outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const row = 'flex h-11 min-w-0 items-center justify-between gap-3 rounded-full bg-background pr-1.5 pl-1.5 text-sm'
</script>

<PageFrame testid="dashboard">
  <PageHeader
    {title}
    description={companyName
      ? `What is happening at ${companyName}, and what needs you.`
      : 'What is happening in your company, and what needs you.'}
  />

  <!-- Go to: the ways into the company, as pills. -->
  <nav class="mt-4 flex min-w-0 flex-wrap gap-1.5" aria-label="Go to" data-testid="dashboard-quick-links">
    {#each quickLinks as item (item.id)}
      {@const Icon = iconFor(item.id)}
      <a href={appHref(item.href)} class={goPill} data-testid="dashboard-link-{item.id}">
        <Icon class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" strokeWidth={1.75} />
        <span class="truncate">{item.name}</span>
      </a>
    {/each}
    {#if assistant}
      <a href={resolve('/assistant')} class={goPill} data-testid="dashboard-link-assistant">
        <Sparkles class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" strokeWidth={1.75} />
        <span class="truncate">Assistant conversations</span>
      </a>
    {/if}
    {#if canInvite}
      <a href={resolve('/settings/members')} class={goPill} data-testid="dashboard-link-invite">
        <UserPlus class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" aria-hidden="true" strokeWidth={1.75} />
        <span class="truncate">Invite a teammate</span>
      </a>
    {/if}
  </nav>

  {#if providerMissing}
    <!-- Kept from the former full-screen gate: without a provider the assistant cannot work.
         The board's black stadium, the coral-rimmed face, a white pill. -->
    <div
      class="mt-4 flex min-w-0 flex-col gap-3 rounded-[1.75rem] bg-ink p-2 text-white sm:flex-row sm:items-center sm:rounded-full"
      data-testid="dashboard-provider-notice"
    >
      <span class="flex min-w-0 items-center gap-3">
        <span class="ring-face size-9 shrink-0" aria-hidden="true"></span>
        <span class="min-w-0 text-sm">
          <span class="font-medium">Connect your AI provider.</span>
          <span class="text-[#a3a3a3]">The assistant and agents work once a provider is connected.</span>
        </span>
      </span>
      <a
        href={resolve('/settings/llm')}
        class="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-black outline-none hover:bg-[#e8e8e8] focus-visible:ring-2 focus-visible:ring-white sm:ml-auto"
        data-testid="dashboard-provider-connect">Connect provider</a
      >
    </div>
  {/if}

  <!-- The board: near-square stages, one widget on each. -->
  <div class="mt-4 grid min-w-0 grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="overview-tiles">
    {#if assistant}
      <!-- Ask: the grey squircle with the mono greeting (the board's "Hey, Annie"). -->
      <section class="stage stage-white min-h-80" aria-label="Ask the assistant" data-testid="dashboard-ask">
        <span class="stage-tag">Assistant</span>
        <div class="squircle widget-grey flex w-full max-w-[19rem] flex-col items-center px-4 pt-5 pb-4 text-center">
          <p class="text-[13px] leading-snug">Ask anything, or ask it to do the work</p>
          <button
            type="button"
            class="display-mono mt-5 rounded-full px-2 outline-none hover:underline hover:decoration-1 hover:underline-offset-[6px] focus-visible:ring-2 focus-visible:ring-white"
            onclick={() => assistant.focusBar()}
            data-testid="dashboard-ask-button">Hey, {greetingName ?? 'there'}</button
          >
          <div class="mt-5 flex flex-wrap justify-center gap-1">
            {#each suggestions as text (text)}
              <button
                type="button"
                class="chip chip-wash h-7 px-3 outline-none hover:bg-[#555555] focus-visible:ring-2 focus-visible:ring-white"
                onclick={() => assistant.prefill(text)}
                data-testid="dashboard-suggestion">{text}</button
              >
            {/each}
          </div>
          <button
            type="button"
            class="ctrl ctrl-circle ctrl-wash mt-4 outline-none hover:bg-[#555555] focus-visible:ring-2 focus-visible:ring-white"
            aria-label="Ask the assistant"
            onclick={() => assistant.focusBar()}
          >
            <Plus class="size-4" aria-hidden="true" strokeWidth={2} />
          </button>
        </div>
      </section>
    {/if}

    <!-- Needs you: the black squircle on slate dusk, the count on the dot-matrix,
         coral while something waits; a hairline legend, ticks on the edges. -->
    <a
      href="#needs-you"
      class="stage stage-dusk min-h-80 {stageLink} {assistant ? '' : 'xl:col-span-2'}"
      data-testid="dashboard-needs-you-tile"
    >
      <span class="stage-tag">Needs you</span>
      <span class="squircle widget-ink relative grid w-full max-w-[18.5rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-5 py-6 pr-6 pl-5">
        <span class="absolute top-0 left-1/2 h-2.5 w-px bg-white" aria-hidden="true"></span>
        <span class="absolute bottom-0 left-1/2 h-2.5 w-px bg-white" aria-hidden="true"></span>
        <span class="absolute top-1/2 left-0 h-px w-2.5 bg-white" aria-hidden="true"></span>
        <span class="absolute top-1/2 right-0 h-px w-2.5 bg-white" aria-hidden="true"></span>
        <span class="block h-24 min-w-0">
          <DotMatrix text={needsYouDisplay} lit={needsYou > 0 ? 'var(--tone-coral)' : '#ffffff'} />
        </span>
        <span class="flex flex-col gap-3">
          <span class="hairline flex flex-col text-sm leading-tight">
            Approvals<span class="on-soft font-mono">{overview.approvals.length}</span>
          </span>
          <span class="hairline flex flex-col text-sm leading-tight">
            Warnings<span class="on-soft font-mono">{dashboard.backup ? 1 : 0}</span>
          </span>
        </span>
        <span class="sr-only">{needsYou} waiting on you</span>
      </span>
    </a>

    <!-- Apps: coral heat in a cream capsule on charcoal (the board's "Stress level"). -->
    <a
      href={websitePage ? appHref(websitePage) : '#modules'}
      class="stage stage-charcoal min-h-80 {stageLink}"
      data-testid="overview-site-tile"
    >
      <span class="stage-tag">Apps</span>
      <span class="widget-heat flex h-60 w-40 flex-col items-center justify-between px-3 pt-6 pb-4">
        <span class="text-[13px] text-[#3b2a22]">On your website</span>
        <span class="flex flex-col items-center">
          <span class="font-mono text-[2.75rem] leading-none text-white">{apps.value}</span>
          <svg class="mt-2 h-8 w-28" viewBox="0 0 112 32" fill="none" aria-hidden="true">
            <path
              d="M2 24 C 16 24, 20 6, 36 6 S 58 28, 72 24 S 92 4, 110 8"
              stroke="#ffffff"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </span>
        <span class="chip chip-taupe h-7 max-w-full px-3"><span class="truncate">{apps.hint}</span></span>
      </span>
    </a>

    <!-- Recent activity: the taupe-into-coral transcript card on stone. -->
    <section class="stage stage-stone min-h-80" data-testid="dashboard-activity">
      <span class="stage-tag">Agents</span>
      <div class="widget-ember flex w-full max-w-[19.5rem] flex-col overflow-hidden rounded-[1.75rem] p-2.5">
        <div class="flex min-w-0 items-center gap-3 rounded-[1.25rem] bg-black/20 py-2 pr-2 pl-2">
          <span class="ring-face size-9 shrink-0" aria-hidden="true"></span>
          <h2 class="min-w-0 flex-1 truncate text-sm font-medium">Recent activity</h2>
          <a
            href={resolve('/assistant/activity')}
            class="chip chip-wash h-7 shrink-0 px-3 outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white">All activity</a
          >
        </div>
        {#if actionGroups.length === 0}
          <p class="px-2 pt-4 pb-3 font-mono text-[13px]">Nothing yet.</p>
        {:else}
          <div class="fade-end mt-2 max-h-52 overflow-y-auto px-2 pb-8" data-testid="overview-actions">
            {#each actionGroups as group (group.label)}
              <div class="min-w-0 pt-2" data-testid="overview-actions-group">
                <h3 class="font-mono text-[13px] font-normal">{group.label}</h3>
                <ol class="mt-1 flex flex-col gap-1.5">
                  {#each group.actions as action, i (i)}
                    <li class="font-mono text-[13px] leading-snug wrap-break-word">
                      <time class="on-soft" datetime={action.at}>{when(action.at)}</time>
                      {action.text}{#if !action.ok}
                        <span class="ml-1 rounded-full bg-white px-1.5 text-[#a8321a]">failed</span>{/if}
                    </li>
                  {/each}
                </ol>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </section>

    <!-- Needs you, in full: pill rows on a white stage. -->
    <section
      id="needs-you"
      class="stage stage-white scroll-mt-6 items-stretch justify-start gap-3 p-5 {assistant ? 'md:col-span-2' : ''} xl:col-span-2"
      data-testid="overview-approvals"
    >
      <div class="hairline">
        <h2 class="text-[15px] leading-snug font-medium">Needs you</h2>
        <p class="on-soft text-sm">Approvals and warnings, waiting on a person</p>
      </div>
      {#if dashboard.backup}
        <div class={row} data-testid="overview-backup-notice" data-kind={dashboard.backup.kind}>
          <span class="flex min-w-0 items-center gap-3">
            <span class="grid size-8 shrink-0 place-items-center rounded-full bg-ink" aria-hidden="true"
              ><span class="size-2 rounded-full bg-destructive"></span></span
            >
            <span class="min-w-0 truncate">{dashboard.backup.text}</span>
          </span>
          <a href={resolve('/settings/backups')} class={inkPill}>Open backups</a>
        </div>
      {/if}
      {#if overview.approvals.length === 0 && !dashboard.backup}
        <p class="{row} pr-4 text-muted-foreground">
          <span class="flex min-w-0 items-center gap-3">
            <span class="grid size-8 shrink-0 place-items-center rounded-full bg-ink" aria-hidden="true"
              ><span class="size-2 rounded-full bg-white"></span></span
            >
            Nothing waiting on you.
          </span>
        </p>
      {:else if overview.approvals.length > 0}
        <ul class="flex flex-col gap-1.5">
          {#each overview.approvals as approval (approval.id)}
            <li class={row}>
              <span class="flex min-w-0 items-center gap-3">
                <span class="grid size-8 shrink-0 place-items-center rounded-full bg-ink" aria-hidden="true"
                  ><span class="size-2 rounded-full bg-coral"></span></span
                >
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
          <p class="text-sm text-muted-foreground" data-testid="overview-approvals-assistant-off">
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
  </div>

  <!-- Active modules: each part on its stage (module-tone.ts). -->
  <section id="modules" class="mt-8 scroll-mt-6">
    <div class="hairline">
      <h2 class="text-[15px] leading-snug font-medium">Modules</h2>
      <p class="text-sm text-muted-foreground">
        {activeModules.length} working for you · <span data-testid="overview-modules-hint">{hint}</span>
      </p>
    </div>
    {#if activeModules.length === 0}
      <p class="mt-3 text-sm text-muted-foreground">No module is active yet.</p>
    {:else}
      <div class="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {#each activeModules as module (module.id)}
          <ModuleCard {module} href={pageOf(module.id)} />
        {/each}
      </div>
    {/if}
  </section>
</PageFrame>
