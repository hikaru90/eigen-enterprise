<script lang="ts">
  import ErrorNotice from '$lib/components/error-notice.svelte'
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import Plus from '@lucide/svelte/icons/plus'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import UserPlus from '@lucide/svelte/icons/user-plus'
  import X from '@lucide/svelte/icons/x'
  import { enhance } from '$app/forms'
  import { resolve } from '$app/paths'
  import { canOpen, type Capabilities } from '$lib/access/capabilities'
  import { assistantIfOn } from '$lib/components/assistant/context'
  import DotMatrix from '$lib/components/dot-matrix.svelte'
  import ModuleCard from '$lib/components/module-card.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { hideTile, showTile, TILE_LABELS, type TileId } from '$lib/dashboard/tiles'
  import { metaLine, updateLine } from '$lib/memory/assigned-task-format'
  import { dueLine } from '$lib/memory/reminder-format'
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
   * link follows the capability set. Every tile closes with its × and comes
   * back from "Hidden tiles" (Contribute 06894ad7); the choice is the person's
   * preference, saved on each change (`saveHiddenTiles`), so it holds on every device.
   */
  let {
    dashboard,
    greetingName,
    companyName,
    navItems,
    capabilities,
    providerMissing,
    mailMissing,
    hiddenTiles,
    saveHiddenTiles,
  }: {
    dashboard: Dashboard
    greetingName: string | null
    companyName: string | null
    navItems: readonly ShellNavItem[]
    /** The shell's capability set (who may manage members and invites, …). */
    capabilities: Capabilities
    /** The company's AI provider is not connected: the assistant cannot work until it is. */
    providerMissing: boolean
    /** An admin, and the company has no sender yet: sign-in codes and mail can't go out. */
    mailMissing: boolean
    /** The tiles this person closed, as last saved. */
    hiddenTiles: readonly TileId[]
    /** Saves the whole list; a rejection undoes the change on the board. */
    saveHiddenTiles: (hidden: TileId[]) => Promise<void>
  } = $props()

  // The board shows the person's choice at once; the saved list catches up behind it.
  // svelte-ignore state_referenced_locally
  let hidden = $state<TileId[]>([...hiddenTiles])
  let tilesError = $state<string | null>(null)
  const shown = (id: TileId) => !hidden.includes(id)

  async function changeTiles(next: TileId[]): Promise<void> {
    const before = hidden
    hidden = next
    tilesError = null
    try {
      await saveHiddenTiles(next)
    } catch (err) {
      hidden = before
      tilesError = `Could not save your tiles: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // null while the Assistant plugin is switched off: no ask box, no way into a panel that is not there.
  const assistant = assistantIfOn()
  const canManagePlugins = $derived(canOpen(capabilities, '/settings/modules'))

  const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))

  const overview = $derived(dashboard.overview)
  const actionGroups = $derived(groupActionsByDay(overview.actions, new Date()))
  const activeModules = $derived(overview.modules.filter((m) => m.active))
  const switchedOff = $derived(overview.modules.length - activeModules.length)
  const tasks = $derived(dashboard.tasks)
  // The person's due reminders: one item each, however many occurrences are open.
  const reminders = $derived(dashboard.reminders)
  const taskCount = $derived(tasks.assignedToMe.length + tasks.updates.length + reminders.length)
  const needsYou = $derived(overview.approvals.length + taskCount + (dashboard.backup ? 1 : 0))
  // Assigned tasks live in Memory › Tasks, reminders in Memory › Reminders; the dashboard's buttons post to those pages' actions.
  const tasksPage = resolve('/m/memory/tasks')
  const remindersPage = resolve('/m/memory/reminders')
  /** The dashboard's snooze: later today (Memory › Reminders offers other lengths). */
  const DASHBOARD_SNOOZE_MINUTES = 180
  const website = $derived(overview.modules.find((m) => m.id === 'website') ?? null)
  const countOf = (label: string) => website?.counts.find((c) => c.label === label)?.value ?? 0
  const apps = $derived.by(() => {
    if (!website || !website.active)
      return { value: 'Off', hint: 'Website module not active', live: false }
    const total = countOf('Apps')
    if (total === 0) return { value: '—', hint: website.note ?? 'No apps yet', live: false }
    const healthy = countOf('Healthy')
    // The website's green "live" dot while at least one app is healthy.
    return { value: String(total), hint: `${healthy} healthy`, live: healthy > 0 }
  })
  const title = $derived(greetingName ? `Welcome back, ${greetingName}` : 'Welcome back')
  const quickLinks = $derived(navItems.filter((i) => i.active && i.id !== 'settings'))
  /** A module's page as the nav lists it for this person; null = not theirs to open. */
  const pageOf = (id: string) => navItems.find((i) => i.id === id)?.href ?? null
  const websitePage = $derived(website ? pageOf(website.id) : null)
  const canInvite = $derived(canOpen(capabilities, '/settings/members'))
  // The Assistant tile exists only while the Assistant is on: nothing to bring back otherwise.
  const restorable = $derived(hidden.filter((id) => id !== 'ask' || assistant))

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
        ? `${switchedOff} switched off — ask the company brain to turn ${switchedOff === 1 ? 'it' : 'them'} on`
        : `${switchedOff} switched off`,
  )

  const goPill =
    'group inline-flex h-8 min-w-0 items-center gap-2 rounded-full bg-card pr-3.5 pl-2.5 text-sm outline-none transition-shadow hover:shadow-[0_1px_2px_rgb(0_0_0/0.06),0_4px_14px_rgb(0_0_0/0.06)] focus-visible:ring-2 focus-visible:ring-ring'
  const inkPill =
    'inline-flex h-8 shrink-0 items-center rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground outline-none hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const stageLink =
    'outline-none transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
  const closeTile =
    'absolute top-3.5 right-3.5 z-10 grid size-7 place-items-center rounded-full bg-white/70 text-[#111111] outline-none transition-opacity hover:bg-white focus-visible:ring-2 focus-visible:ring-ring pointer-fine:opacity-0 pointer-fine:group-hover/tile:opacity-100 pointer-fine:focus-visible:opacity-100'
  const row =
    'flex h-11 min-w-0 items-center justify-between gap-3 rounded-full bg-background pr-1.5 pl-1.5 text-sm'
  const taskRow =
    'flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-[1.375rem] bg-background py-1.5 pr-1.5 pl-1.5 text-sm'
  const softPill =
    'inline-flex h-8 shrink-0 items-center rounded-full bg-muted px-3.5 text-sm font-medium outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
</script>

{#snippet close(id: TileId)}
  <button
    type="button"
    class={closeTile}
    aria-label="Hide {TILE_LABELS[id]}"
    title="Hide this tile"
    onclick={() => changeTiles(hideTile(hidden, id))}
    data-testid="dashboard-hide-{id}"
  >
    <X class="size-3.5" aria-hidden="true" strokeWidth={2} />
  </button>
{/snippet}

<PageFrame testid="dashboard">
  <PageHeader
    {title}
    description={companyName
      ? `What is happening at ${companyName}, and what needs you.`
      : 'What is happening in your company, and what needs you.'}
  />

  <!-- Go to: the ways into the company, as pills. -->
  <nav
    class="mt-4 flex min-w-0 flex-wrap gap-1.5"
    aria-label="Go to"
    data-testid="dashboard-quick-links"
  >
    {#each quickLinks as item (item.id)}
      {@const Icon = iconFor(item.id)}
      <a href={appHref(item.href)} class={goPill} data-testid="dashboard-link-{item.id}">
        <Icon
          class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
          aria-hidden="true"
          strokeWidth={1.75}
        />
        <span class="truncate">{item.name}</span>
      </a>
    {/each}
    {#if assistant}
      <a href={resolve('/assistant')} class={goPill} data-testid="dashboard-link-assistant">
        <Sparkles
          class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
          aria-hidden="true"
          strokeWidth={1.75}
        />
        <span class="truncate">Assistant conversations</span>
      </a>
    {/if}
    {#if canInvite}
      <a href={resolve('/settings/members')} class={goPill} data-testid="dashboard-link-invite">
        <UserPlus
          class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
          aria-hidden="true"
          strokeWidth={1.75}
        />
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
          <span class="text-[#a3a3a3]"
            >The assistant and agents work once a provider is connected.</span
          >
        </span>
      </span>
      <a
        href={resolve('/settings/llm')}
        class="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-black outline-none hover:bg-[#e8e8e8] focus-visible:ring-2 focus-visible:ring-white sm:ml-auto"
        data-testid="dashboard-provider-connect">Connect provider</a
      >
    </div>
  {/if}

  {#if mailMissing}
    <!-- Sign-in codes go out by email: without a sender nobody gets back in by code (passkeys still work). -->
    <div
      class="mt-4 flex min-w-0 flex-col gap-3 rounded-[1.75rem] bg-ink p-2 text-white sm:flex-row sm:items-center sm:rounded-full"
      data-testid="dashboard-mail-notice"
    >
      <span class="flex min-w-0 items-center gap-3">
        <span class="ring-face size-9 shrink-0" aria-hidden="true"></span>
        <span class="min-w-0 text-sm">
          <span class="font-medium">Set up company email.</span>
          <span class="text-[#a3a3a3]"
            >Until then no email goes out — not even sign-in codes, so only passkeys get anyone back
            in.</span
          >
        </span>
      </span>
      <a
        href={resolve('/m/email/setup')}
        class="inline-flex h-9 shrink-0 items-center justify-center rounded-full bg-white px-4 text-sm font-medium text-black outline-none hover:bg-[#e8e8e8] focus-visible:ring-2 focus-visible:ring-white sm:ml-auto"
        data-testid="dashboard-mail-setup">Set up email</a
      >
    </div>
  {/if}

  <!-- The board: near-square stages, one widget on each. -->
  <div
    class="mt-4 grid min-w-0 grid-flow-row-dense grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3"
    data-testid="overview-tiles"
  >
    {#if assistant && shown('ask')}
      <div class="group/tile relative min-w-0">
        <!-- Ask: the website's ice tile with the assistant's blue orb, the mono greeting
           (the board's "Hey, Annie"); suggestions are white pills that turn the assistant's yellow. -->
        <section
          class="stage stage-ice h-full min-h-80"
          aria-label="Ask the company brain"
          data-testid="dashboard-ask"
        >
          <span class="stage-tag">Assistant</span>
          <div class="flex w-full max-w-[19rem] flex-col items-center text-center">
            <span class="orb size-20" aria-hidden="true" data-testid="dashboard-ask-orb"></span>
            <p class="on-soft mt-3 text-[13px] leading-snug">
              Ask anything, or ask it to do the work
            </p>
            <button
              type="button"
              class="display-mono mt-2 rounded-full px-2 outline-none hover:underline hover:decoration-1 hover:underline-offset-[6px] focus-visible:ring-2 focus-visible:ring-ring"
              onclick={() => assistant.focusBar()}
              data-testid="dashboard-ask-button">Hey, {greetingName ?? 'there'}</button
            >
            <div class="mt-5 flex flex-wrap justify-center gap-1">
              {#each suggestions as text (text)}
                <button
                  type="button"
                  class="chip h-7 bg-white px-3 outline-none transition-colors hover:bg-(--tone-yellow) focus-visible:ring-2 focus-visible:ring-ring"
                  onclick={() => assistant.prefill(text)}
                  data-testid="dashboard-suggestion">{text}</button
                >
              {/each}
            </div>
            <button
              type="button"
              class="ctrl ctrl-circle ctrl-ink mt-4 outline-none hover:bg-black focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Ask the company brain"
              onclick={() => assistant.focusBar()}
            >
              <Plus class="size-4" aria-hidden="true" strokeWidth={2} />
            </button>
          </div>
        </section>
        {@render close('ask')}
      </div>
    {/if}

    <!-- Needs you: the black squircle on slate dusk, the count on the dot-matrix,
         coral while something waits; a hairline legend, ticks on the edges. -->
    {#if shown('needs-you')}
      <div class="group/tile relative min-w-0 {assistant ? '' : 'xl:col-span-2'}">
        <a
          href="#needs-you"
          class="stage stage-dusk grain h-full min-h-80 {stageLink}"
          data-testid="dashboard-needs-you-tile"
        >
          <span class="stage-tag">Needs you</span>
          <span
            class="squircle widget-ink relative grid w-full max-w-[18.5rem] grid-cols-[minmax(0,1fr)_auto] items-center gap-5 py-6 pr-6 pl-5"
          >
            <span class="absolute top-0 left-1/2 h-2.5 w-px bg-white" aria-hidden="true"></span>
            <span class="absolute bottom-0 left-1/2 h-2.5 w-px bg-white" aria-hidden="true"></span>
            <span class="absolute top-1/2 left-0 h-px w-2.5 bg-white" aria-hidden="true"></span>
            <span class="absolute top-1/2 right-0 h-px w-2.5 bg-white" aria-hidden="true"></span>
            <span class="block h-24 min-w-0">
              <DotMatrix
                text={needsYouDisplay}
                lit={needsYou > 0 ? 'var(--tone-coral)' : '#ffffff'}
              />
            </span>
            <span class="flex flex-col gap-3">
              <span class="hairline flex flex-col text-sm leading-tight">
                Approvals<span class="on-soft font-mono">{overview.approvals.length}</span>
              </span>
              <span class="hairline flex flex-col text-sm leading-tight">
                Tasks<span class="on-soft font-mono">{taskCount}</span>
              </span>
              <span class="hairline flex flex-col text-sm leading-tight">
                Warnings<span class="on-soft font-mono">{dashboard.backup ? 1 : 0}</span>
              </span>
            </span>
            <span class="sr-only">{needsYou} waiting on you</span>
          </span>
        </a>
        {@render close('needs-you')}
      </div>
    {/if}

    <!-- Apps: coral heat in a cream capsule (the board's "Stress level") over the
         website's warm pillar — light rising from below on near-black. -->
    {#if shown('apps')}
      <div class="group/tile relative min-w-0">
        <a
          href={websitePage ? appHref(websitePage) : '#modules'}
          class="stage stage-glow grain h-full min-h-80 {stageLink}"
          data-testid="overview-site-tile"
        >
          <span class="stage-tag">Apps</span>
          <span
            class="widget-heat flex h-60 w-40 flex-col items-center justify-between px-3 pt-6 pb-4"
          >
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
            <span
              class="chip chip-taupe h-7 max-w-full px-3 {apps.live ? 'chip-dot chip-live' : ''}"
              data-testid="overview-apps-hint"><span class="truncate">{apps.hint}</span></span
            >
          </span>
        </a>
        {@render close('apps')}
      </div>
    {/if}

    <!-- Recent activity: the taupe-into-coral transcript card on stone. -->
    {#if shown('activity')}
      <div class="group/tile relative min-w-0">
        <section class="stage stage-stone h-full min-h-80" data-testid="dashboard-activity">
          <span class="stage-tag">Agents</span>
          <div
            class="widget-ember flex w-full max-w-[19.5rem] flex-col overflow-hidden rounded-[1.75rem] p-2.5"
          >
            <div
              class="flex min-w-0 items-center gap-3 rounded-[1.25rem] bg-black/20 py-2 pr-2 pl-2"
            >
              <span class="ring-face size-9 shrink-0" aria-hidden="true"></span>
              <h2 class="min-w-0 flex-1 truncate text-sm font-medium">Recent activity</h2>
              <a
                href={resolve('/assistant/activity')}
                class="chip chip-wash h-7 shrink-0 px-3 outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white"
                >All activity</a
              >
            </div>
            {#if actionGroups.length === 0}
              <p class="px-2 pt-4 pb-3 font-mono text-[13px]">Nothing yet.</p>
            {:else}
              <div
                class="fade-end mt-2 max-h-52 overflow-y-auto px-2 pb-8"
                data-testid="overview-actions"
              >
                {#each actionGroups as group (group.label)}
                  <div class="min-w-0 pt-2" data-testid="overview-actions-group">
                    <h3 class="font-mono text-[13px] font-normal">{group.label}</h3>
                    <ol class="mt-1 flex flex-col gap-1.5">
                      {#each group.actions as action, i (i)}
                        <li class="font-mono text-[13px] leading-snug wrap-break-word">
                          <time class="on-soft" datetime={action.at}>{when(action.at)}</time>
                          {action.text}{#if !action.ok}
                            <span class="ml-1 rounded-full bg-white px-1.5 text-[#a8321a]"
                              >failed</span
                            >{/if}
                        </li>
                      {/each}
                    </ol>
                  </div>
                {/each}
              </div>
            {/if}
          </div>
        </section>
        {@render close('activity')}
      </div>
    {/if}

    <!-- Needs you, in full: pill rows on a white stage. -->
    {#if shown('approvals')}
      <div class="group/tile relative min-w-0 {assistant ? 'md:col-span-2' : ''} xl:col-span-2">
        <section
          id="needs-you"
          class="stage stage-white h-full scroll-mt-6 items-stretch justify-start gap-3 p-5"
          data-testid="overview-approvals"
        >
          <div class="hairline pr-8">
            <h2 class="text-[15px] leading-snug font-medium">Needs you</h2>
            <p class="on-soft text-sm">
              Approvals, tasks, reminders and warnings, waiting on a person
            </p>
          </div>
          {#if dashboard.backup}
            <div class={row} data-testid="overview-backup-notice" data-kind={dashboard.backup.kind}>
              <span class="flex min-w-0 items-center gap-3">
                <span
                  class="grid size-8 shrink-0 place-items-center rounded-full bg-ink"
                  aria-hidden="true"><span class="size-2 rounded-full bg-destructive"></span></span
                >
                <span class="min-w-0 truncate">{dashboard.backup.text}</span>
              </span>
              <a href={resolve('/settings/backups')} class={inkPill}>Open backups</a>
            </div>
          {/if}
          {#if taskCount > 0}
            <!-- Tasks other members gave this person, what happened on the ones they gave out, and their own due reminders. -->
            <ul class="flex flex-col gap-1.5" data-testid="dashboard-tasks">
              {#each tasks.assignedToMe as task (task.id)}
                <li class={taskRow} data-testid="dashboard-task-assigned">
                  <span class="flex min-w-0 items-center gap-3">
                    <span
                      class="grid size-8 shrink-0 place-items-center rounded-full bg-ink"
                      aria-hidden="true"><span class="size-2 rounded-full bg-coral"></span></span
                    >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate">{task.title}</span>
                      <span class="truncate text-muted-foreground"
                        >{metaLine(task)}{task.context ? ` · ${task.context}` : ''}</span
                      >
                    </span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5">
                    <a href="{tasksPage}#assigned-{task.id}" class={softPill}>Open</a>
                    <form method="POST" action="{tasksPage}?/complete" use:enhance>
                      <input type="hidden" name="task_id" value={task.id} />
                      <button type="submit" class={inkPill} data-testid="dashboard-task-done"
                        >Done</button
                      >
                    </form>
                  </span>
                </li>
              {/each}
              {#each tasks.updates as task (task.id)}
                <li class={taskRow} data-testid="dashboard-task-update">
                  <span class="flex min-w-0 items-center gap-3">
                    <span
                      class="grid size-8 shrink-0 place-items-center rounded-full bg-ink"
                      aria-hidden="true"><span class="size-2 rounded-full bg-white"></span></span
                    >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate">{updateLine(task)}</span>
                      <span class="truncate text-muted-foreground">{metaLine(task)}</span>
                    </span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5">
                    <a href="{tasksPage}#assigned-{task.id}" class={softPill}>Open</a>
                    <form method="POST" action="{tasksPage}?/seen" use:enhance>
                      <input type="hidden" name="task_id" value={task.id} />
                      <button type="submit" class={inkPill} data-testid="dashboard-task-seen"
                        >Got it</button
                      >
                    </form>
                  </span>
                </li>
              {/each}
              {#each reminders as reminder (reminder.id)}
                <li class={taskRow} data-testid="dashboard-reminder">
                  <span class="flex min-w-0 items-center gap-3">
                    <span
                      class="grid size-8 shrink-0 place-items-center rounded-full bg-ink"
                      aria-hidden="true"><span class="size-2 rounded-full bg-coral"></span></span
                    >
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate">{reminder.title}</span>
                      <span class="truncate text-muted-foreground"
                        >{dueLine(reminder)}{reminder.note ? ` · ${reminder.note}` : ''}</span
                      >
                    </span>
                  </span>
                  <span class="flex shrink-0 items-center gap-1.5">
                    <a href="{remindersPage}#reminder-{reminder.id}" class={softPill}>Open</a>
                    <form method="POST" action="{remindersPage}?/snooze" use:enhance>
                      <input type="hidden" name="reminder_id" value={reminder.id} />
                      <input type="hidden" name="minutes" value={DASHBOARD_SNOOZE_MINUTES} />
                      <button
                        type="submit"
                        class={softPill}
                        title="Snooze for 3 hours"
                        data-testid="dashboard-reminder-snooze">Later</button
                      >
                    </form>
                    {#if reminder.due && reminder.due.count > 1}
                      <form method="POST" action="{remindersPage}?/complete" use:enhance>
                        <input type="hidden" name="reminder_id" value={reminder.id} />
                        <input type="hidden" name="all" value="1" />
                        <button
                          type="submit"
                          class={softPill}
                          data-testid="dashboard-reminder-done-all"
                          >All {reminder.due.count} done</button
                        >
                      </form>
                    {/if}
                    <form method="POST" action="{remindersPage}?/complete" use:enhance>
                      <input type="hidden" name="reminder_id" value={reminder.id} />
                      <button type="submit" class={inkPill} data-testid="dashboard-reminder-done"
                        >Done</button
                      >
                    </form>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
          {#if overview.approvals.length === 0 && !dashboard.backup && taskCount === 0}
            <p class="{row} pr-4 text-muted-foreground">
              <span class="flex min-w-0 items-center gap-3">
                <span
                  class="grid size-8 shrink-0 place-items-center rounded-full bg-ink"
                  aria-hidden="true"><span class="size-2 rounded-full bg-white"></span></span
                >
                Nothing waiting on you.
              </span>
            </p>
          {:else if overview.approvals.length > 0}
            <ul class="flex flex-col gap-1.5">
              {#each overview.approvals as approval (approval.id)}
                <li class={row}>
                  <span class="flex min-w-0 items-center gap-3">
                    <span
                      class="grid size-8 shrink-0 place-items-center rounded-full bg-ink"
                      aria-hidden="true"><span class="size-2 rounded-full bg-coral"></span></span
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
              <p
                class="text-sm text-muted-foreground"
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
        {@render close('approvals')}
      </div>
    {/if}
  </div>

  {#if tilesError}
    <ErrorNotice
      class="mt-2"
      testid="dashboard-tiles-error"
      error={tilesError}
      attempted="Saving your dashboard tiles"
    />
  {/if}
  {#if restorable.length > 0}
    <!-- The tiles this person closed, to bring back. -->
    <div
      class="mt-3 flex min-w-0 flex-wrap items-center gap-1.5"
      data-testid="dashboard-hidden-tiles"
    >
      <span class="mr-1 text-sm text-muted-foreground">Hidden tiles</span>
      {#each restorable as id (id)}
        <button
          type="button"
          class={goPill}
          aria-label="Show {TILE_LABELS[id]}"
          onclick={() => changeTiles(showTile(hidden, id))}
        >
          <Plus
            class="size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
            aria-hidden="true"
            strokeWidth={1.75}
          />
          <span class="truncate">{TILE_LABELS[id]}</span>
        </button>
      {/each}
    </div>
  {/if}

  <!-- Active modules: each part on its stage (module-tone.ts). -->
  <section id="modules" class="mt-8 scroll-mt-6">
    <div class="hairline">
      <h2 class="text-[15px] leading-snug font-medium">Modules</h2>
      <p class="text-sm text-muted-foreground">
        {activeModules.length} working for you ·
        <span data-testid="overview-modules-hint">{hint}</span>
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
