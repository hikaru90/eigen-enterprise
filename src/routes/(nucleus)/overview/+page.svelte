<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- data-held hrefs go through appHref(), which calls resolve() */
  import type { PageData } from './$types'
  import { resolve } from '$app/paths'
  import ModuleCard from '$lib/components/module-card.svelte'
  import { appHref } from '$lib/shell/href'
  import { moduleHref } from '$lib/shell/nav'

  let { data }: { data: PageData } = $props()

  const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const when = (iso: string) => timeFormat.format(new Date(iso))

  const activeModules = $derived(data.overview.modules.filter((m) => m.active))
  const available = $derived(data.overview.modules.length - activeModules.length)
  const website = $derived(data.overview.modules.find((m) => m.id === 'website') ?? null)
  const countOf = (label: string) => website?.counts.find((c) => c.label === label)?.value ?? 0
  const apps = $derived.by(() => {
    if (!website || !website.active) return { value: 'Off', hint: 'Website module not active' }
    const total = countOf('Apps')
    if (total === 0) return { value: '—', hint: website.note ?? 'No apps yet' }
    return { value: String(total), hint: `${countOf('Healthy')} healthy` }
  })

  const tile =
    'flex min-w-0 flex-col rounded-lg border border-border bg-background px-4 py-3.5 transition-colors outline-none hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring/60'
</script>

<svelte:head><title>Overview · Eigen Enterprise</title></svelte:head>

<div class="mx-auto w-full max-w-5xl px-4 pt-6 pb-16 sm:px-8 sm:pt-10">
  <header class="flex min-w-0 flex-col gap-1">
    <h1 class="text-xl font-semibold tracking-tight">Overview</h1>
    <p class="text-sm text-foreground/55">What is running and where the work is.</p>
  </header>

  <!-- Status tiles -->
  <div class="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="overview-tiles">
    <a href="#modules" class={tile}>
      <span class="text-xs text-foreground/55">Active modules</span>
      <span class="mt-1 text-2xl font-semibold tabular-nums">{activeModules.length}</span>
      <span class="mt-0.5 text-xs text-foreground/45">{available} available</span>
    </a>
    <a href="#needs-you" class={tile}>
      <span class="text-xs text-foreground/55">Needs you</span>
      <span class="mt-1 flex items-center gap-2 text-2xl font-semibold tabular-nums">
        {data.overview.approvals.length}
        {#if data.overview.approvals.length > 0}<span
            class="size-2 rounded-full bg-eigen-green"
            aria-hidden="true"
          ></span>{/if}
      </span>
      <span class="mt-0.5 text-xs text-foreground/45">Pending approvals</span>
    </a>
    <a
      href={website ? appHref(moduleHref(website.id)) : '#modules'}
      class={tile}
      data-testid="overview-site-tile"
    >
      <span class="text-xs text-foreground/55">Apps</span>
      <span class="mt-1 text-2xl font-semibold">{apps.value}</span>
      <span class="mt-0.5 truncate text-xs text-foreground/45">{apps.hint}</span>
    </a>
  </div>

  <div class="mt-10 grid min-w-0 grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
    <div class="min-w-0">
      <!-- Needs you -->
      <section id="needs-you" class="scroll-mt-6" data-testid="overview-approvals">
        <h2 class="text-[13px] font-medium">Needs you</h2>
        {#if data.overview.approvals.length === 0}
          <p class="mt-2 rounded-lg border border-border px-4 py-3 text-sm text-foreground/55">
            Nothing waiting on you.
          </p>
        {:else}
          <ul class="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border">
            {#each data.overview.approvals as approval (approval.id)}
              <li class="flex min-w-0 items-center justify-between gap-3 px-4 py-2.5 text-sm">
                <span class="flex min-w-0 items-center gap-2.5">
                  <span class="size-1.5 shrink-0 rounded-full bg-eigen-green" aria-hidden="true"
                  ></span>
                  <span class="min-w-0 truncate">{approval.text}</span>
                </span>
                <a
                  href={resolve('/')}
                  class="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium outline-none hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/60"
                  >Review</a
                >
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <!-- Active modules -->
      <section id="modules" class="mt-10 scroll-mt-6">
        <h2 class="text-[13px] font-medium">Modules</h2>
        {#if activeModules.length === 0}
          <p class="mt-2 text-sm text-foreground/55">No module is active yet.</p>
        {:else}
          <div class="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {#each activeModules as module (module.id)}
              <ModuleCard {module} />
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <!-- Recent activity -->
    <section class="min-w-0">
      <h2 class="text-[13px] font-medium">Recent activity</h2>
      {#if data.overview.actions.length === 0}
        <p class="mt-2 text-sm text-foreground/55">Nothing yet.</p>
      {:else}
        <ol class="mt-3 border-l border-border" data-testid="overview-actions">
          {#each data.overview.actions as action, i (i)}
            <li class="relative min-w-0 pb-4 pl-4 last:pb-0">
              <span
                class="absolute top-1.5 -left-[3.5px] size-1.5 rounded-full {action.ok
                  ? 'bg-foreground/35'
                  : 'bg-red-500'}"
                aria-hidden="true"
              ></span>
              <p class="text-sm leading-snug wrap-break-word">
                {action.text}{#if !action.ok}<span class="text-xs text-red-600">
                    · failed</span
                  >{/if}
              </p>
              <time class="text-xs text-foreground/45" datetime={action.at}>{when(action.at)}</time>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  </div>
</div>
