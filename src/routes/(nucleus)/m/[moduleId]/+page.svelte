<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import ModuleSettingsSection from '$lib/components/module-settings-section.svelte'
  import OverviewModule from '$lib/components/overview-module.svelte'
  import PageFrame from '$lib/components/page/page-frame.svelte'
  import PageHeader from '$lib/components/page/page-header.svelte'
  import WebsiteActivityPanel from '$lib/components/website-activity-panel.svelte'
  import { moduleSettingsSlot } from '$lib/shell/module-settings'
  import { docTitle } from '$lib/shell/title'

  let { data }: { data: PageData } = $props()
  const slot = $derived(moduleSettingsSlot(data.module.id))
</script>

<svelte:head><title>{docTitle(data.module.name)}</title></svelte:head>

<PageFrame>
  <PageHeader
    title={data.module.name}
    description={data.module.description || null}
    status={{ label: data.module.active ? 'Active' : 'Not active', on: data.module.active }}
  />

  {#if !data.module.active}
    <section
      class="mt-8 rounded-lg border border-dashed border-border px-5 py-6"
      data-testid="module-inactive"
    >
      <h2 class="text-sm font-medium">Not active</h2>
      <p class="mt-1 text-sm text-foreground/60">
        This module is installed but switched off, so it does no work and shows no results. Ask in
        the chat to turn it on; its results and settings appear here once it is active.
      </p>
      <a
        href={resolve('/')}
        class="mt-4 inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-foreground outline-none hover:bg-primary/85 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
        >Open chat</a
      >
    </section>
  {:else}
    <section class="mt-8" aria-labelledby="results-heading">
      {#if data.module.results.length === 0 && !data.module.note}
        <h2 id="results-heading" class="text-[13px] font-medium">Results</h2>
        <p class="mt-2 text-sm text-foreground/55">Nothing to show yet.</p>
      {:else}
        <span id="results-heading" class="sr-only">{data.module.resultsTitle}</span>
        <OverviewModule module={data.module} />
      {/if}
    </section>

    {#if slot?.panel === 'website-activity' && (data.activity || data.activityError)}
      <section class="mt-10" aria-labelledby="activity-heading">
        <span id="activity-heading" class="sr-only">Recent activity</span>
        <WebsiteActivityPanel activity={data.activity} error={data.activityError} />
      </section>
    {/if}

    <section class="mt-10" aria-labelledby="settings-heading">
      <h2 id="settings-heading" class="mb-2 text-[13px] font-medium">Settings</h2>
      <ModuleSettingsSection {slot} />
    </section>

  {/if}
</PageFrame>
