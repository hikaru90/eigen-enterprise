<script lang="ts">
  import { page } from '$app/state'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import { currentSettingsSection, settingsSections } from '$lib/shell/settings-nav'

  /**
   * Settings inside the shell: the one page header with the company-wide
   * sections as tabs below it (rule 3) — only the ones this person may open
   * (the shell's capability set). Pages outside those sections render bare.
   */
  let { data, children } = $props()

  const tabs = $derived(
    data.shell
      ? settingsSections(data.shell.capabilities).map((s) => ({ id: s.id, label: s.name, href: s.href }))
      : [],
  )
  const current = $derived(currentSettingsSection(page.url.pathname))
</script>

{#if current}
  <PageFrame testid="settings-frame">
    <PageHeader
      title="Settings"
      description="What applies to the whole company. Each module keeps its own settings on its page."
      {tabs}
      {current}
      navLabel="Settings sections"
      navTestId="settings-nav"
      tabTestId={(id) => `settings-nav-${id}`}
    />
    <div class="mt-8 max-w-2xl">
      {@render children()}
    </div>
  </PageFrame>
{:else}
  {@render children()}
{/if}
