<script lang="ts">
  import type { PageProps } from './$types'

  /**
   * Extension Roadmap: what the system did (shipped), what changed, what is
   * planned. Read-only mirror of the roadmap module's store — content is
   * managed through the kernel tools (roadmap.add_item / roadmap.update_item),
   * so there is deliberately no add/edit UI here. Empty sections render their
   * heading and nothing else — honest, no filler.
   */

  let { data }: PageProps = $props()

  const shipped = $derived(data.items.filter((item) => item.status === 'shipped'))
  const inProgress = $derived(data.items.filter((item) => item.status === 'in_progress'))
  const planned = $derived(data.items.filter((item) => item.status === 'planned'))

  /** A shipped item always carries its stamp (store invariant); anything else fails loud. */
  function formatDate(iso: string | null): string {
    if (!iso) throw new Error('shipped roadmap item without shipped_at')
    return new Date(iso).toLocaleDateString()
  }
</script>

<svelte:head>
  <title>Extensions · Eigen Enterprise</title>
</svelte:head>

<div class="mx-auto w-full max-w-2xl px-4 py-10">
  <header class="mb-8">
    <p class="text-muted-foreground text-[11px] font-medium tracking-[0.25em] uppercase">
      Eigen Enterprise
    </p>
    <h1 class="mt-1 text-xl font-medium tracking-tight">Extension Roadmap</h1>
    <p class="text-muted-foreground mt-2 text-xs">
      What shipped, what is in the queue, what is planned. Maintained by the agent through the
      roadmap module's kernel tools.
    </p>
  </header>

  <main class="space-y-8">
    <section class="space-y-3" data-testid="roadmap-shipped">
      <h2 class="text-sm font-semibold">Shipped</h2>
      <ul class="border-black/15 divide-y divide-black/10 border">
        {#each shipped as item (item.id)}
          <li class="flex items-start justify-between gap-4 px-4 py-2.5">
            <div>
              <p class="text-sm">{item.title}</p>
              <p class="text-muted-foreground mt-0.5 text-xs">{item.detail}</p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <span
                class="border-black/15 text-muted-foreground border px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
              >
                {item.kind}
              </span>
              <span class="text-muted-foreground text-xs">{formatDate(item.shippedAt)}</span>
            </div>
          </li>
        {/each}
      </ul>
    </section>

    <section class="space-y-3" data-testid="roadmap-in-progress">
      <h2 class="text-sm font-semibold">In the queue</h2>
      <ul class="border-black/15 divide-y divide-black/10 border">
        {#each inProgress as item (item.id)}
          <li class="px-4 py-2.5">
            <div class="flex items-start justify-between gap-4">
              <p class="text-sm">{item.title}</p>
              <span
                class="border-black/15 text-muted-foreground shrink-0 border px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
              >
                {item.kind}
              </span>
            </div>
            <p class="text-muted-foreground mt-0.5 text-xs">{item.detail}</p>
          </li>
        {/each}
      </ul>
    </section>

    <section class="space-y-3" data-testid="roadmap-planned">
      <h2 class="text-sm font-semibold">Planned</h2>
      <ul class="border-black/15 divide-y divide-black/10 border">
        {#each planned as item (item.id)}
          <li class="px-4 py-2.5">
            <div class="flex items-start justify-between gap-4">
              <p class="text-sm">{item.title}</p>
              <span
                class="border-black/15 text-muted-foreground shrink-0 border px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
              >
                {item.kind}
              </span>
            </div>
            <p class="text-muted-foreground mt-0.5 text-xs">{item.detail}</p>
          </li>
        {/each}
      </ul>
    </section>
  </main>
</div>
