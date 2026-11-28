<script lang="ts">
  /* eslint-disable svelte/no-navigation-without-resolve -- the grouping is resolve() + a query string */
  import type { PageProps } from './$types'
  import { resolve } from '$app/paths'

  /** Product signals hub (plan/traces-phone-home.md T4): error rate and p95 per tool, model or version. */
  let { data }: PageProps = $props()
  const pct = (r: number) => `${(r * 100).toFixed(1)} %`
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-base font-semibold tracking-tight">Product signals</h2>
    <p class="text-xs text-foreground/60">What every box shared, {data.from_day} to {data.to_day}. Usage statistics only, never content.</p>
  </div>
  <nav class="flex flex-wrap gap-2 text-xs">
    {#each data.groups as g (g)}
      <a class="rounded-full border border-border px-2 py-0.5 {g === data.groupBy ? 'bg-foreground/[0.06] font-medium' : ''}" href={`${resolve('/(nucleus)/settings/traces-hub')}?by=${g}`}>{g}</a>
    {/each}
  </nav>
  {#if data.rows.length === 0}
    <p class="text-sm text-foreground/60">No signals yet.</p>
  {:else}
    <table class="w-full text-left text-xs" data-testid="hub-stats">
      <thead class="text-foreground/60">
        <tr><th class="py-1">{data.groupBy}</th><th>Spans</th><th>Error rate</th><th>p50</th><th>p95</th><th>Installs</th><th>Cost</th></tr>
      </thead>
      <tbody>
        {#each data.rows as r (r.key ?? '—')}
          <tr class="border-t border-border">
            <td class="py-1 [overflow-wrap:anywhere]">{r.key ?? '—'}</td>
            <td>{r.spans}</td>
            <td>{pct(r.errorRate)}</td>
            <td>{r.p50Ms ?? '—'} ms</td>
            <td>{r.p95Ms ?? '—'} ms</td>
            <td>{r.installs}</td>
            <td>${r.costUsd.toFixed(4)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
