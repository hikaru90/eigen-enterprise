<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import type { Snippet } from 'svelte'
  import type { Component } from 'svelte'
  import Box from '@lucide/svelte/icons/box'
  import Brain from '@lucide/svelte/icons/brain'
  import Globe from '@lucide/svelte/icons/globe'
  import LayoutDashboard from '@lucide/svelte/icons/layout-dashboard'
  import Mail from '@lucide/svelte/icons/mail'
  import Menu from '@lucide/svelte/icons/menu'
  import MessageSquare from '@lucide/svelte/icons/message-square'
  import Palette from '@lucide/svelte/icons/palette'
  import Server from '@lucide/svelte/icons/server'
  import Settings from '@lucide/svelte/icons/settings'
  import X from '@lucide/svelte/icons/x'
  import { appHref } from '$lib/shell/href'
  import HomeSettingsMenu from '$lib/components/home-settings-menu.svelte'
  import { navItemCurrent, type ShellData, type ShellNavItem } from '$lib/shell/nav'

  /**
   * The signed-in app frame: a left sidebar on desktop (company, nav, user),
   * a top bar with a drawer on phones. The content area is a fixed-height
   * column so full-height pages (the chat) keep their own scroll container.
   */
  let {
    shell,
    pathname,
    user,
    children,
  }: {
    shell: ShellData
    pathname: string
    user: { name?: string | null; email?: string | null } | null
    children: Snippet
  } = $props()

  let drawerOpen = $state(false)

  // Presentation only: an icon per known id; any other module gets the generic box.
  const icons: Record<string, Component> = {
    chat: MessageSquare,
    overview: LayoutDashboard,
    settings: Settings,
    website: Globe,
    owlery: Mail,
    email: Mail,
    brand: Palette,
    memory: Brain,
    substrate: Server,
  }
  const iconFor = (id: string): Component => icons[id] ?? Box

  const companyName = $derived(shell.companyName ?? 'Your company')
  const initial = $derived(companyName.slice(0, 1).toUpperCase())
  const userLabel = $derived(user?.name || user?.email || 'Signed in')

  function closeDrawer(): void {
    drawerOpen = false
  }
  function toggleDrawer(): void {
    drawerOpen = !drawerOpen
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && drawerOpen) drawerOpen = false
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet navLink(item: ShellNavItem, dimmed: boolean)}
  {@const Icon = iconFor(item.id)}
  {@const current = navItemCurrent(item.href, pathname)}
  <a
    href={appHref(item.href)}
    onclick={closeDrawer}
    aria-current={current ? 'page' : undefined}
    data-testid="shell-nav-{item.id}"
    class="group flex h-8 min-w-0 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60
      {current
      ? 'bg-foreground/[0.06] font-medium text-foreground'
      : dimmed
        ? 'text-foreground/40 hover:bg-foreground/[0.04] hover:text-foreground/70'
        : 'text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground'}"
  >
    <Icon
      class="size-4 shrink-0 {current ? 'text-foreground' : 'opacity-70'}"
      aria-hidden="true"
      strokeWidth={1.75}
    />
    <span class="min-w-0 truncate">{item.name}</span>
  </a>
{/snippet}

{#snippet sectionLabel(text: string)}
  <p class="px-2 pt-5 pb-1 text-[11px] font-medium text-foreground/40">{text}</p>
{/snippet}

{#snippet sidebar()}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-14 shrink-0 items-center gap-2.5 px-4">
      <span
        class="flex size-6 shrink-0 items-center justify-center rounded-md bg-foreground text-[11px] font-semibold text-background"
        aria-hidden="true">{initial}</span
      >
      <span
        class="min-w-0 truncate text-sm font-semibold tracking-tight"
        data-testid="shell-company">{companyName}</span
      >
    </div>
    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label="Main">
      <ul class="flex flex-col gap-px">
        {#each shell.nav.primary as item (item.id)}<li>{@render navLink(item, false)}</li>{/each}
      </ul>
      {#if shell.nav.modules.length > 0}
        {@render sectionLabel('Modules')}
        <ul class="flex flex-col gap-px" data-testid="shell-modules">
          {#each shell.nav.modules as item (item.id)}<li>{@render navLink(item, false)}</li>{/each}
        </ul>
      {/if}
      {#if shell.nav.available.length > 0}
        {@render sectionLabel('Available')}
        <ul class="flex flex-col gap-px" data-testid="shell-available">
          {#each shell.nav.available as item (item.id)}<li>{@render navLink(item, true)}</li>{/each}
        </ul>
      {/if}
      <ul class="mt-5 flex flex-col gap-px border-t border-border pt-3">
        {#each shell.nav.secondary as item (item.id)}<li>{@render navLink(item, false)}</li>{/each}
      </ul>
    </nav>
    <div class="flex shrink-0 items-center gap-2.5 border-t border-border px-3 py-3">
      <span
        class="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[11px] font-medium"
        aria-hidden="true">{userLabel.slice(0, 1).toUpperCase()}</span
      >
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
  class="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground md:flex-row"
  data-testid="app-shell"
>
  <!-- Desktop sidebar -->
  <aside
    class="hidden w-60 shrink-0 border-r border-border bg-sidebar md:block"
    data-testid="shell-sidebar"
  >
    {@render sidebar()}
  </aside>

  <!-- Phone top bar -->
  <header class="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 md:hidden">
    <button
      type="button"
      class="-ml-1.5 flex size-8 items-center justify-center rounded-md text-foreground/70 outline-none hover:bg-foreground/[0.05] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
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
    <span class="min-w-0 truncate text-sm font-semibold tracking-tight">{companyName}</span>
  </header>

  {#if drawerOpen}
    <div class="fixed inset-0 z-40 md:hidden">
      <button
        type="button"
        class="absolute inset-0 bg-black/30"
        aria-label="Close menu"
        tabindex="-1"
        onclick={closeDrawer}
      ></button>
      <aside
        id="shell-drawer"
        class="absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-border bg-background shadow-xl"
        data-testid="shell-drawer"
      >
        {@render sidebar()}
      </aside>
    </div>
  {/if}

  <div
    class="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
    data-testid="shell-content"
  >
    {@render children()}
  </div>
</div>
