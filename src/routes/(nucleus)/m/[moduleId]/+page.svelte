<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import MailKeysPanel from '$lib/components/mail-keys-panel.svelte'
  import ModuleSettingsSection from '$lib/components/module-settings-section.svelte'
  import OverviewModule from '$lib/components/overview-module.svelte'
  import { moduleSettingsSlot } from '$lib/shell/module-settings'

  let { data }: { data: PageData } = $props()
  const slot = $derived(moduleSettingsSlot(data.module.id))
</script>

<svelte:head><title>{data.module.name} · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-4xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1.5 border-b border-border pb-6">
    <div class="flex min-w-0 items-center gap-3">
      <h1 class="min-w-0 truncate text-xl font-semibold tracking-tight">{data.module.name}</h1>
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium {data
          .module.active
          ? 'text-foreground'
          : 'text-foreground/50'}"
        data-testid="module-status"
      >
        <span
          class="size-1.5 rounded-full {data.module.active ? 'bg-eigen-green' : 'bg-foreground/25'}"
          aria-hidden="true"
        ></span>
        {data.module.active ? 'Active' : 'Not active'}
      </span>
    </div>
    {#if data.module.description}
      <p class="text-sm text-foreground/60">{data.module.description}</p>
    {/if}
  </header>

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
        class="mt-4 inline-flex h-8 items-center rounded-md bg-foreground px-3 text-[13px] font-medium text-background outline-none hover:bg-foreground/85 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
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

    <section class="mt-10" aria-labelledby="settings-heading">
      <h2 id="settings-heading" class="mb-2 text-[13px] font-medium">Settings</h2>
      <ModuleSettingsSection {slot} />
      {#if slot?.panel === 'mail-keys'}<MailKeysPanel />{/if}
    </section>
  {/if}
</div>
