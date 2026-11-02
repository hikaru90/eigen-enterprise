<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- section hrefs go through appHref(), which calls resolve() */
  import { page } from '$app/state'
  import { appHref } from '$lib/shell/href'
  import { currentSettingsSection, settingsSections } from '$lib/shell/settings-nav'

  /**
   * Settings inside the shell: one sub-navigation for the company-wide
   * sections (rule 3). Pages outside those sections (the roadmap, still at
   * /settings/extensions until the Agent page takes it) render bare.
   */
  let { children } = $props()

  const isAdmin = $derived((page.data as { isAdmin?: boolean }).isAdmin === true)
  const sections = $derived(settingsSections(isAdmin))
  const current = $derived(currentSettingsSection(page.url.pathname))
</script>

{#if current}
  <div class="mx-auto w-full max-w-3xl px-4 py-8 md:px-8 md:py-10" data-testid="settings-frame">
    <p class="text-[11px] font-medium text-foreground/50">Settings</p>
    <nav
      class="-mx-1 mt-3 mb-8 flex gap-1 overflow-x-auto border-b border-border pb-px"
      aria-label="Settings sections"
      data-testid="settings-nav"
    >
      {#each sections as section (section.id)}
        <a
          href={appHref(section.href)}
          aria-current={current === section.id ? 'page' : undefined}
          data-testid="settings-nav-{section.id}"
          class="-mb-px shrink-0 border-b-2 px-2 py-2 text-[13px] whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60
            {current === section.id
            ? 'border-foreground font-medium text-foreground'
            : 'border-transparent text-foreground/60 hover:text-foreground'}"
        >
          {section.name}
        </a>
      {/each}
    </nav>
    {@render children()}
  </div>
{:else}
  {@render children()}
{/if}
