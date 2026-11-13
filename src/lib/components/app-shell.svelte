<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import type { Snippet } from 'svelte'
  import Menu from '@lucide/svelte/icons/menu'
  import X from '@lucide/svelte/icons/x'
  import { onMount } from 'svelte'
  import { afterNavigate, replaceState } from '$app/navigation'
  import { resolve } from '$app/paths'
  import AssistantBar from '$lib/components/assistant/assistant-bar.svelte'
  import { AssistantController } from '$lib/components/assistant/assistant-controller.svelte'
  import AssistantPanel from '$lib/components/assistant/assistant-panel.svelte'
  import { provideAssistant } from '$lib/components/assistant/context'
  import ContributeButton from '$lib/components/contribute/contribute-button.svelte'
  import HomeSettingsMenu from '$lib/components/home-settings-menu.svelte'
  import { presenceLabel } from '$lib/messages/presence'
  import PresenceDot from '$lib/messages/presence-dot.svelte'
  import PresenceNav from '$lib/messages/presence-nav.svelte'
  import type { SelfPresence } from '$lib/messages/self-presence.svelte'
  import { appHref } from '$lib/shell/href'
  import { iconFor } from '$lib/shell/module-icon'
  import { toneOf } from '$lib/shell/module-tone'
  import { currentNavId, type ShellData, type ShellNavItem } from '$lib/shell/nav'
  import { cancelSpeak, speak } from '$lib/speech/tts'

  /**
   * Brand-wide (C3): every chrome colour is a semantic token — primary for
   * the highlight, badge and focus, sidebar/border/foreground for the frame,
   * overlay for the scrim — so an active visual set re-skins the whole
   * shell. In the app's own style primary == foreground (#111), so with no
   * active set the frame looks exactly as before.
   *
   * The signed-in app frame: a left sidebar on desktop (company = the
   * dashboard link, nav, user), a drawer on phones. The content column has
   * the assistant's top bar ("Ask the assistant…", ⌘K) and, below it, the
   * page next to the assistant panel (polish P-1) — both only while the
   * Assistant plugin is on (shell.assistant). The page area is a
   * fixed-height column so full-height pages keep their own scroll container.
   */
  let {
    shell,
    pathname,
    user,
    language,
    presence,
    children,
  }: {
    shell: ShellData
    pathname: string
    user: { name?: string | null; email?: string | null; image?: string | null } | null
    /** The member's speech language (voice input in the assistant). */
    language: string
    /**
     * My own status (Contribute e4ef6be1), shown at the foot of the nav and
     * on the phone's menu button; null while Messages, which owns presence,
     * is off — then there is no status anywhere (off means off).
     */
    presence: SelfPresence | null
    children: Snippet
  } = $props()

  let drawerOpen = $state(false)

  // The one assistant: shared by the top bar, the panel and the pages inside the shell.
  // Only while the Assistant plugin is on (round 5): switched off there is no
  // assistant at all — no top bar field, no panel, nothing loaded. The page
  // data of the load decides; a switch takes effect on the next full load.
  // svelte-ignore state_referenced_locally
  const assistant = shell.assistant
    ? new AssistantController({
        fetch: (input, init) => fetch(input, init),
        speak,
        cancelSpeak,
        storage: () => localStorage,
        viewportWidth: () => window.innerWidth,
      })
    : null
  provideAssistant(assistant)

  onMount(() => {
    // The welcome wizard's hand-off (handoff.ts): the agent's greeting streams into the panel.
    assistant?.startPendingHandoff()
  })

  // A deep-linked draft (?prefill=, e.g. from the Apps "+" dialog) lands in the
  // assistant's composer for the member to review and send — never auto-sent.
  // With the Assistant off the draft stays in the address: there is no composer.
  afterNavigate(({ to }) => {
    const prefill = to?.url.searchParams.get('prefill')
    if (!to || !prefill || !assistant) return
    assistant.prefill(prefill)
    const clean = new URL(to.url)
    clean.searchParams.delete('prefill')
    replaceState(clean, {})
  })

  const currentId = $derived(currentNavId(shell.nav.items, pathname))
  const mainItems = $derived(shell.nav.items.filter((i) => i.id !== 'settings'))
  const footerItems = $derived(shell.nav.items.filter((i) => i.id === 'settings'))
  const onDashboard = $derived(pathname === '/')

  const companyName = $derived(shell.companyName ?? 'Your company')
  const initial = $derived(companyName.slice(0, 1).toUpperCase())
  // Settings → Company: the logo replaces the initial badge.
  const companyLogo = $derived(shell.companyLogo)
  const userLabel = $derived(user?.name || user?.email || 'Signed in')
  const userImage = $derived(user?.image?.trim() || null)
  const myStatus = $derived(presence?.view ?? null)
  const menuLabel = $derived(
    (drawerOpen ? 'Close menu' : 'Open menu') + (myStatus ? ` — your status: ${presenceLabel(myStatus, new Date())}` : ''),
  )

  function closeDrawer(): void {
    drawerOpen = false
  }
  function toggleDrawer(): void {
    drawerOpen = !drawerOpen
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && drawerOpen) {
      drawerOpen = false
      event.preventDefault()
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Nav links switch colors without a transition: the old item fading out while the new one
     fades in read as two current items at once. -->
{#snippet navLink(item: ShellNavItem)}
  {@const Icon = iconFor(item.id)}
  {@const current = currentId === item.id}
  {@const dimmed = !item.active}
  <!-- The website's nav: full pills, the current one inked; each part's icon
       sits in a circle of the colour it wears on the website (module-tone.ts). -->
  <a
    href={appHref(item.href)}
    onclick={closeDrawer}
    aria-current={current ? 'page' : undefined}
    data-testid="shell-nav-{item.id}"
    class="group flex h-10 min-w-0 items-center gap-3 rounded-full pr-3 pl-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring
      {current
      ? 'bg-primary text-primary-foreground'
      : dimmed
        ? 'text-muted-foreground hover:bg-card'
        : 'text-foreground hover:bg-card'}"
  >
    <span class="ico size-8 {dimmed ? 'ico-grey' : `ico-${toneOf(item.id)}`}" aria-hidden="true">
      <Icon class="size-4" strokeWidth={1.75} />
    </span>
    <span class="min-w-0 truncate">{item.name}</span>
    {#if dimmed}<span class="chip ml-auto h-6 shrink-0 px-2 {current ? '' : 'chip-line'}">Off</span>{/if}
  </a>
{/snippet}

{#snippet sidebar()}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 items-center px-3 pt-4 pb-2">
      <!-- The company is the way home: its dashboard at / (polish P-2). -->
      <a
        href={resolve('/')}
        onclick={closeDrawer}
        aria-current={onDashboard ? 'page' : undefined}
        data-testid="shell-company-link"
        title="Dashboard"
        class="group flex h-14 min-w-0 flex-1 items-center gap-3 rounded-full pr-4 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring
          {onDashboard ? 'bg-card' : 'hover:bg-card'}"
      >
        {#if companyLogo}
          <img
            src={companyLogo}
            alt=""
            data-testid="shell-company-logo"
            class="size-10 shrink-0 rounded-full object-contain transition-transform group-hover:scale-105"
          />
        {:else}
          <span
            data-testid="shell-company-badge"
            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-signal-yellow font-mono text-sm text-black transition-transform group-hover:scale-105"
            aria-hidden="true">{initial}</span
          >
        {/if}
        <span class="flex min-w-0 flex-col leading-tight">
          <span class="truncate text-[15px] font-medium tracking-tight" data-testid="shell-company"
            >{companyName}</span
          >
          <span class="mono-label truncate text-xs text-muted-foreground">Dashboard</span>
        </span>
      </a>
    </div>
    <nav class="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4" aria-label="Main">
      <ul class="flex flex-col gap-1" data-testid="shell-nav">
        {#each mainItems as item (item.id)}<li>{@render navLink(item)}</li>{/each}
      </ul>
      <ul class="mt-6 flex flex-col gap-1">
        {#each footerItems as item (item.id)}<li>{@render navLink(item)}</li>{/each}
      </ul>
    </nav>
    <div class="mx-3 mb-3 flex shrink-0 items-center gap-2.5 rounded-full bg-card py-2 pr-2 pl-2.5" data-testid="shell-user-footer">
      {#if presence}
        <PresenceNav
          self={presence}
          name={userLabel}
          email={user?.name && user.email ? user.email : null}
          image={userImage}
        />
      {:else if userImage}
        <img
          src={userImage}
          alt=""
          class="size-8 shrink-0 rounded-full object-cover"
          data-testid="shell-user-avatar"
        />
      {:else}
        <span
          class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-xs text-primary-foreground"
          data-testid="shell-user-initial"
          aria-hidden="true">{userLabel.slice(0, 1).toUpperCase()}</span
        >
      {/if}
      {#if !presence}
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-medium" data-testid="shell-user">{userLabel}</p>
          {#if user?.name && user.email}<p class="truncate text-xs text-muted-foreground">
              {user.email}
            </p>{/if}
        </div>
      {/if}
      <HomeSettingsMenu />
    </div>
  </div>
{/snippet}

<div
  class="flex h-dvh w-full flex-row overflow-hidden bg-background text-foreground"
  data-testid="app-shell"
>
  <!-- Desktop sidebar -->
  <aside
    class="hidden w-64 shrink-0 bg-background md:block"
    data-testid="shell-sidebar"
  >
    {@render sidebar()}
  </aside>

  {#if drawerOpen}
    <div class="fixed inset-0 z-40 md:hidden">
      <button
        type="button"
        class="absolute inset-0 bg-overlay/30"
        aria-label="Close menu"
        tabindex="-1"
        onclick={closeDrawer}
      ></button>
      <aside
        id="shell-drawer"
        class="absolute inset-y-0 left-0 w-72 max-w-[85vw] rounded-r-[2rem] bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl"
        data-testid="shell-drawer"
      >
        {@render sidebar()}
      </aside>
    </div>
  {/if}

  <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="shell-column">
    <!-- The assistant's top bar, on every signed-in page (on phones with the menu). -->
    <header
      class="box-content flex h-16 shrink-0 items-center gap-2 bg-background px-3 pt-[env(safe-area-inset-top)] sm:px-6"
      data-testid="shell-topbar"
    >
      <button
        type="button"
        class="relative -ml-1 flex size-10 shrink-0 items-center justify-center rounded-full bg-card text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:hidden"
        aria-label={menuLabel}
        aria-expanded={drawerOpen}
        aria-controls="shell-drawer"
        onclick={toggleDrawer}
        data-testid="shell-menu-toggle"
      >
        {#if drawerOpen}<X class="size-5" aria-hidden="true" />{:else}<Menu
            class="size-5"
            aria-hidden="true"
          />{/if}
        <!-- Phones: the nav is in the drawer, so my status rides on its button. -->
        {#if myStatus}
          <PresenceDot
            presence={myStatus}
            now={new Date()}
            size={10}
            class="pointer-events-none absolute top-0.5 right-0.5"
            testid="shell-menu-presence"
          />
        {/if}
      </button>
      <div class="flex min-w-0 flex-1 justify-center">
        {#if assistant}
          <div class="flex w-full max-w-3xl min-w-0">
            <AssistantBar {assistant} />
          </div>
        {/if}
      </div>
      <!-- Top right: anyone proposes an improvement to the app (the Contribute board). -->
      <ContributeButton />
    </header>

    <div class="flex min-h-0 min-w-0 flex-1 flex-row">
      <div
        class="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pb-[env(safe-area-inset-bottom)]"
        data-testid="shell-content"
      >
        {@render children()}
      </div>
      {#if assistant}<AssistantPanel {assistant} {language} />{/if}
    </div>
  </div>
</div>
