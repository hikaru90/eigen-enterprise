<script lang="ts">
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import OverviewModule from '$lib/components/overview-module.svelte'

  let { data }: { data: PageData } = $props()

  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))
  const label = 'text-[11px] font-medium tracking-[0.2em] text-black/60 uppercase'
</script>

<svelte:head><title>Overview · Eigen Enterprise</title></svelte:head>

<div class="min-h-dvh w-full overflow-x-hidden bg-white text-black">
  <div class="mx-auto w-full max-w-3xl px-4 pt-6 pb-12 sm:px-6">
    <header class="flex items-baseline justify-between gap-3">
      <p class="text-[11px] font-medium tracking-[0.25em] text-black/60 uppercase">Overview</p>
      <a href={resolve('/')} class="text-xs underline underline-offset-2">Back to chat</a>
    </header>
    <p class="mt-2 text-xs text-black/50">What is running and where the work is. Ask in the chat for detail.</p>

    {#if data.overview.approvals.length > 0}
      <section class="mt-6 rounded-sm border-2 border-black px-3 py-3" data-testid="overview-approvals">
        <p class={label}>Needs your approval</p>
        <ul class="mt-1 divide-y divide-black/10">
          {#each data.overview.approvals as approval (approval.id)}
            <li class="flex min-w-0 items-baseline justify-between gap-3 py-1.5 text-sm">
              <span class="min-w-0 wrap-break-word">{approval.text}</span>
              <a href={resolve('/')} class="shrink-0 text-xs underline underline-offset-2">Open in chat</a>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <h1 class="mt-6 {label}">Modules</h1>
    <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
      {#each data.overview.modules as module (module.id)}
        <OverviewModule {module} />
      {/each}
    </div>

    <h2 class="mt-8 {label}">Recent agent actions</h2>
    {#if data.overview.actions.length === 0}
      <p class="mt-2 text-xs text-black/50">Nothing yet.</p>
    {:else}
      <ul class="mt-1 divide-y divide-black/10 border-y border-black/10" data-testid="overview-actions">
        {#each data.overview.actions as action, i (i)}
          <li class="flex min-w-0 items-baseline justify-between gap-3 py-1.5 text-sm">
            <span class="min-w-0 wrap-break-word">
              {action.text}{#if !action.ok}<span class="text-xs text-black/50"> · failed</span>{/if}
            </span>
            <time class="shrink-0 text-xs text-black/50" datetime={action.at}>{when(action.at)}</time>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
