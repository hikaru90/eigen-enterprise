<script lang="ts">
  import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right'
  import type { Pathname } from '$app/types'
  import type { ModuleOverview } from '$lib/server/overview/overview'
  import { appHref } from '$lib/shell/href'
  import { iconFor } from '$lib/shell/module-icon'
  import { isDark, toneOf } from '$lib/shell/module-tone'

  /**
   * A dashboard card for one active module: status dot, key counts, link to
   * its page. `href` is the module's page as the nav lists it for this
   * person; null = a page they can't open (e.g. Website for a member), so the
   * card shows the module but is no link — never a way into a 403.
   */
  let { module, href }: { module: ModuleOverview; href: Pathname | null } = $props()

  // The part's stage and its icon (module-tone.ts).
  const tone = $derived(toneOf(module.id))
  const Icon = $derived(iconFor(module.id))
</script>

<!-- A stage (near-square) with a squircle icon, the name, and its counts as pills. -->
<svelte:element
  this={href ? 'a' : 'div'}
  href={href ? appHref(href) : undefined}
  class="stage stage-{tone} group min-h-48 items-stretch justify-start p-5 outline-none {href
    ? 'transition-transform hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
    : ''}"
  data-testid="module-card"
>
  <div class="flex min-w-0 items-center justify-between gap-2">
    <span
      class="grid size-10 shrink-0 place-items-center rounded-[0.75rem] {isDark(tone)
        ? 'bg-white text-[#111111]'
        : 'bg-ink text-white'}"
      aria-hidden="true"
    >
      <Icon class="size-[18px]" strokeWidth={1.75} />
    </span>
    <span class="chip chip-wash chip-dot {module.active ? '' : 'chip-off'}">{module.active ? 'On' : 'Off'}</span>
  </div>
  <h3 class="mt-auto flex min-w-0 items-center gap-1.5 pt-6 text-[15px] font-medium">
    <span class="min-w-0 truncate">{module.name}</span>
    {#if href}
      <ArrowUpRight
        class="size-4 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
        aria-hidden="true"
      />
    {/if}
  </h3>
  <p class="on-soft mt-1 line-clamp-2 text-sm leading-relaxed">{module.description}</p>
  {#if module.counts.length > 0}
    <dl class="mt-3 flex flex-wrap gap-1.5">
      {#each module.counts as count (count.label)}
        <div class="chip chip-wash min-w-0">
          <dt class="on-soft">{count.label}</dt>
          <dd class="font-mono" data-testid="module-card-count-{count.label}">{count.value}</dd>
        </div>
      {/each}
    </dl>
  {:else if module.note}
    <p class="on-soft mt-3 text-sm">{module.note}</p>
  {:else if module.results.length > 0}
    <p class="mt-3 truncate text-sm">
      {module.results[0].label}{#if module.results[0].detail}<span class="on-soft">
          · {module.results[0].detail}</span
        >{/if}
    </p>
  {/if}
</svelte:element>
