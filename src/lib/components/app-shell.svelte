<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import type { Snippet } from 'svelte'
  import type { Component } from 'svelte'
  import Box from '@lucide/svelte/icons/box'
  import Brain from '@lucide/svelte/icons/brain'
  import Globe from '@lucide/svelte/icons/globe'
  import HardDrive from '@lucide/svelte/icons/hard-drive'
  import Mail from '@lucide/svelte/icons/mail'
  import Menu from '@lucide/svelte/icons/menu'
  import MessagesSquare from '@lucide/svelte/icons/messages-square'
  import Palette from '@lucide/svelte/icons/palette'
  import Settings from '@lucide/svelte/icons/settings'
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
  import { appHref } from '$lib/shell/href'
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
   * page next to the assistant panel (polish P-1). The page area is a
   * fixed-height column so full-height pages keep their own scroll container.
   */
  let {
    shell,
    pathname,
    user,
    language,
    children,
  }: {
    shell: ShellData
    pathname: string
    user: { name?: string | null; email?: string | null; image?: string | null } | null
    /** The member's speech language (voice input in the assistant). */
    language: string
    children: Snippet
  } = $props()

  let drawerOpen = $state(false)

  // The one assistant: shared by the top bar, the panel and the pages inside the shell.
  const assistant = new AssistantController({
    fetch: (input, init) => fetch(input, init),
    speak,
    cancelSpeak,
    storage: () => localStorage,
    viewportWidth: () => window.innerWidth,
  })
  provideAssistant(assistant)

  onMount(() => {
    // The welcome wizard's hand-off (handoff.ts): the agent's greeting streams into the panel.
    assistant.startPendingHandoff()
  })

  // A deep-linked draft (?prefill=, e.g. from the Apps "+" dialog) lands in the
  // assistant's composer for the member to review and send — never auto-sent.
  afterNavigate(({ to }) => {
    const prefill = to?.url.searchParams.get('prefill')
    if (!to || !prefill) return
    assistant.prefill(prefill)
    const clean = new URL(to.url)
    clean.searchParams.delete('prefill')
    replaceState(clean, {})
  })

  // Presentation only: an icon per known id; any other module gets the generic box.
  const icons: Record<string, Component> = {
    messages: MessagesSquare,
    settings: Settings,
    website: Globe,
    email: Mail,
    brand: Palette,
    memory: Brain,
    drive: HardDrive,
  }
  const iconFor = (id: string): Component => icons[id] ?? Box
  const currentId = $derived(currentNavId(shell.nav.items, pathname))
  const mainItems = $derived(shell.nav.items.filter((i) => i.id !== 'settings'))
  const footerItems = $derived(shell.nav.items.filter((i) => i.id === 'settings'))
  const onDashboard = $derived(pathname === '/')

  const companyName = $derived(shell.companyName ?? 'Your company')
  const initial = $derived(companyName.slice(0, 1).toUpperCase())
  const userLabel = $derived(user?.name || user?.email || 'Signed in')
  const userImage = $derived(user?.image?.trim() || null)

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
  <a
    href={appHref(item.href)}
    onclick={closeDrawer}
    aria-current={current ? 'page' : undefined}
    data-testid="shell-nav-{item.id}"
    class="group flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/60
      {current
      ? 'bg-primary/[0.08] font-medium text-foreground'
      : dimmed
        ? 'text-foreground/40 hover:bg-primary/[0.05] hover:text-foreground/70'
        : 'text-foreground/70 hover:bg-primary/[0.05] hover:text-foreground'}"
  >
    <Icon
      class="size-4 shrink-0 {current ? 'text-primary' : 'opacity-70 group-hover:opacity-100'}"
      aria-hidden="true"
      strokeWidth={1.75}
    />
    <span class="min-w-0 truncate">{item.name}</span>
    {#if dimmed}<span class="ml-auto shrink-0 text-[10px] text-foreground/35">Off</span>{/if}
  </a>
{/snippet}

{#snippet sidebar()}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-14 shrink-0 items-center px-2">
      <!-- The company is the way home: its dashboard at / (polish P-2). -->
      <a
        href={resolve('/')}
        onclick={closeDrawer}
        aria-current={onDashboard ? 'page' : undefined}
        data-testid="shell-company-link"
        title="Dashboard"
        class="group flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/60
          {onDashboard ? 'bg-primary/[0.08]' : 'hover:bg-primary/[0.05]'}"
      >
        <span
          data-testid="shell-company-badge"
          class="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground shadow-sm transition-transform group-hover:scale-105"
          aria-hidden="true">{initial}</span
        >
        <span class="flex min-w-0 flex-col leading-tight">
          <span class="truncate text-sm font-semibold tracking-tight" data-testid="shell-company"
            >{companyName}</span
          >
          <span class="truncate text-[11px] text-foreground/50">Dashboard</span>
        </span>
      </a>
    </div>
    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4" aria-label="Main">
      <ul class="flex flex-col gap-px" data-testid="shell-nav">
        {#each mainItems as item (item.id)}<li>{@render navLink(item)}</li>{/each}
      </ul>
      <ul class="mt-5 flex flex-col gap-px border-t border-border pt-3">
        {#each footerItems as item (item.id)}<li>{@render navLink(item)}</li>{/each}
      </ul>
    </nav>
    <div class="flex shrink-0 items-center gap-2.5 border-t border-border px-3 py-3">
      {#if userImage}
        <img
          src={userImage}
          alt=""
          class="size-7 shrink-0 rounded-full object-cover"
          data-testid="shell-user-avatar"
        />
      {:else}
        <span
          class="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/[0.08] text-[11px] font-medium"
          data-testid="shell-user-initial"
          aria-hidden="true">{userLabel.slice(0, 1).toUpperCase()}</span
        >
      {/if}
      <div class="min-w-0 flex-1">
        <p class="truncate text-[13px] font-medium" data-testid="shell-user">{userLabel}</p>
        {#if user?.name && user.email}<p class="truncate text-[11px] text-foreground/50">
            {user.email}
          </p>{/if}
      </div>
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
    class="hidden w-60 shrink-0 border-r border-border bg-sidebar md:block"
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
        class="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-sidebar pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-xl"
        data-testid="shell-drawer"
      >
        {@render sidebar()}
      </aside>
    </div>
  {/if}

  <div class="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="shell-column">
    <!-- The assistant's top bar, on every signed-in page (on phones with the menu). -->
    <header
      class="box-content flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3 pt-[env(safe-area-inset-top)] sm:px-4"
      data-testid="shell-topbar"
    >
      <button
        type="button"
        class="-ml-1 flex size-8 shrink-0 items-center justify-center rounded-md text-foreground/70 outline-none hover:bg-primary/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 md:hidden"
        aria-label={drawerOpen ? 'Close menu' : 'Open menu'}
        aria-expanded={drawerOpen}
        aria-controls="shell-drawer"
        onclick={toggleDrawer}
        data-testid="shell-menu-toggle"
      >
        {#if drawerOpen}<X class="size-5" aria-hidden="true" />{:else}<Menu
            class="size-5"
            aria-hidden="true"
          />{/if}
      </button>
      <div class="flex min-w-0 flex-1 justify-center">
        <div class="flex w-full max-w-2xl min-w-0">
          <AssistantBar {assistant} />
        </div>
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
      <AssistantPanel {assistant} {language} />
    </div>
  </div>
</div>
